'use strict';
const storage = require('node-persist');
const moment = require('moment');
const { convert } = require('html-to-text');

class Bot {

  constructor(log, config, calendar, discord) {
    this.log = log;
    this.config = config;
    this.calendar = calendar;
    this.discord = discord;
    this.discord.bot = this;
    this.state = {
      channels: {},
      accounts: {}
    };

    this.rsvpStorage = storage.create({ dir: 'persist-rsvp' });
  }

  async init() {
    await this.rsvpStorage.init();
    await this.loadState();
  }

  start() {
    if (this.intervalTimeout)
      return;

    setImmediate(() => {
      this.update(true)
        .catch(err => { this.log.error(err, "Error in first update") });
    });
    this.intervalTimeout = setInterval(() => {
      this.update()
        .catch(err => { this.log.error(err, "Error in update") });
    }, this.config.refreshInterval);
  }

  async update(firstRun) {
    try {
      await this.updateCalendarEvents();
    } catch (err) {
      this.log.error(err, "Error during calendar sync");
    }
    try {
      await this.refreshAllRsvp(firstRun);
    } catch (err) {
      this.log.error(err, "Error during rsvp refresh");
    }
  }

  async updateCalendarEvents() {
    await this.calendar.updateEvents(async event => {
      const rsvp = await this.updateRsvp(event);
      if (!rsvp.cancelled && !rsvp.past) {
        // Invite users in the Discord role to the event. Always sync
        // invites from the event to the rsvp so that it's populated.
        if (rsvp.posted)
          this.addInvites(rsvp);
        await this.syncInvites(rsvp, event);
      }
      this.log.info(rsvp, "RSVP updated from calendar");
      try {
        await this.discord.updateMessage(rsvp);
      } finally {
        await this.saveRsvp(rsvp);
      }
    });
  }

  async refreshAllRsvp(firstRun) {
    const roles = new Map();

    await this.foreachRsvp(async rsvp => {
      // Sync reactions to messages when we first run.
      if (firstRun) {
        await this.discord.syncReactions(rsvp);
        await this.discord.syncInterested(rsvp);
      }
      // Refresh rsvp properties.
      let needsUpdate = this.refreshRsvp(rsvp);
      if (!rsvp.past) {
        // Invite users in the Discord role to the event. If the invite set
        // has changed, sync invites from the rsvp back to the event.
        if ((rsvp.posted || !rsvp.future) && this.addInvites(rsvp)) {
          this.log.info(rsvp, "Invites needs sync");
          const event = await this.calendar.getEvent(rsvp.eventId);
          await this.syncInvites(rsvp, event);
          needsUpdate = true;
        }
        // Update the tracking of the next role event.
        if (rsvp.invite && rsvp.invite !== '' &&
          (!roles.get(rsvp.invite) || roles.get(rsvp.invite).start > rsvp.start)) {
          roles.set(rsvp.invite, rsvp);
        }
      }
      // Update the message and save the updated rsvp entry.
      if (needsUpdate || firstRun) {
        this.log.info(rsvp, "RSVP updated from refresh");
        try {
          await this.discord.updateMessage(rsvp);
        } finally {
          await this.saveRsvp(rsvp);
        }
      }
    });

    // Check whether we have new next role events.
    for (const [role, rsvp] of roles) {
      if (rsvp.posted)
        continue;
      this.log.debug(`Next event for ${role} is ${rsvp.eventId}, will send invites`);
      // Invite users in the Discord role to the event. If the invite set
      // has changed, sync invites from the rsvp back to the event.
      if (this.addInvites(rsvp)) {
        this.log.info(rsvp, "Invites needs sync");
        const event = await this.calendar.getEvent(rsvp.eventId);
        await this.syncInvites(rsvp, event);
      }
      try {
        await this.discord.updateMessage(rsvp);
      } finally {
        await this.saveRsvp(rsvp);
      }
    }
  }

  stop() {
    clearInterval(this.intervalTimeout);
    this.intervalTimeout = undefined;
    this.saveState()
      .catch(err => { this.log.error(err, "Error saving state") });
  }

  async loadState() {
    const state = await storage.getItem('state');
    if (state)
      this.state = state;
  }

  async saveState() {
    await storage.setItem('state', this.state);
  }

  async getRsvp(eventId) {
    const rsvp = await this.rsvpStorage.getItem(eventId);
    if (rsvp)
      this.fixRsvpTypes(rsvp);
    return rsvp;
  }

  async foreachRsvp(callback) {
    const rsvps = await this.rsvpStorage.values();
    for (const rsvp of rsvps) {
      this.fixRsvpTypes(rsvp);
      await callback(rsvp);
    }
  }

  async findRsvp(predicate) {
    const rsvps = await this.rsvpStorage.values();
    for (const rsvp of rsvps) {
      this.fixRsvpTypes(rsvp);
      if (predicate(rsvp))
        return rsvp;
    }
  }

  fixRsvpTypes(rsvp) {
    if (rsvp.start)
      rsvp.start = moment(rsvp.start);
    if (rsvp.end)
      rsvp.end = moment(rsvp.end);
    if (rsvp.invite)
      rsvp.invite = rsvp.invite.toLowerCase();
    if (!rsvp.changed)
      rsvp.changed = [];
    if (!rsvp.interested)
      rsvp.interested = [];
    if (!rsvp.zoom)
      rsvp.zoom = [];

    return rsvp;
  }

  async saveRsvp(rsvp) {
    delete rsvp.significantChange;
    if (rsvp.past || rsvp.cancelled) {
      await this.rsvpStorage.removeItem(rsvp.eventId);
    } else {
      await this.rsvpStorage.setItem(rsvp.eventId, rsvp);
    }
  }

  async updateRsvp(event) {
    this.log.debug(event, "Update RSVP from event");
    let rsvp = await this.getRsvp(event.id);
    if (!rsvp) {
      rsvp = {
        'eventId': event.id,
        'yes': [],
        'no': [],
        'invited': [],
        'changed': [],
        'interested': [],
        'zoom': []
      };
    }

    if (event.status === 'cancelled') {
      rsvp.cancelled = true;
      return rsvp;
    } else {
      delete rsvp.cancelled;
    }

    const start = moment(event.start.dateTime || event.start.date);
    if (rsvp.start && Math.abs(rsvp.start.diff(start, 'hours')) > 4) {
      rsvp.significantChange = true;
    } else {
      delete rsvp.significantChange;
    }
    rsvp.start = start;

    const endDate = event.end.dateTime || event.end.date;
    rsvp.end = endDate ? moment(endDate) : undefined;

    rsvp.title = event.summary;
    rsvp.location = event.location;

    // Parse the description each time looking for keywords.
    if (event.description) {
      let plainText;
      if (event.description.includes('<')) {
        plainText = convert(event.description, {
          wordwrap: false,
          selectors: [
            { selector: 'a', options: { ignoreHref: true } }
          ],
        });
      } else {
        plainText = event.description.trim();
      }

      let newLines = [];
      const lines = plainText.split('\n');
      for (const line of lines) {
        if (line.toLowerCase().startsWith('image:')) {
          rsvp.image = line.substring(6).trim();
        } else if (line.toLowerCase().startsWith('invite:')) {
          const invite = line.substring(7).trim().toLowerCase();
          if (rsvp.invite && rsvp.invite !== '' && rsvp.invite !== invite) {
            rsvp.significantChange = true;
          }
          rsvp.invite = invite;
        } else {
          newLines.push(line);
        }
      }

      rsvp.description = newLines.join('\n').trim();
    }

    // Set the color based on the role.
    if (!rsvp.color && rsvp.invite && rsvp.invite !== '') {
      try {
        const { members, color } = this.discord.getRole(rsvp.invite);
        rsvp.color = color;
      } catch (err) {
        this.log.warn(err, `No such role: ${rsvp.invite}`);
      }
    }

    this.refreshRsvp(rsvp);

    return rsvp;
  }

  refreshRsvp(rsvp) {
    const now = moment();
    let needsRefresh = false;

    const past = rsvp.end && rsvp.end < now;
    if (rsvp.past !== past)
      needsRefresh = true;
    rsvp.past = past;

    const future = rsvp.start.diff(now, 'days') > this.config.limit;
    if (rsvp.future !== future)
      needsRefresh = true;
    rsvp.future = past;

    let fromNow = rsvp.start.fromNow();
    if (rsvp.end && rsvp.end < now) {
      fromNow = "past";
    } else if (rsvp.start && rsvp.start < now) {
      fromNow = "started";
    }
    if (rsvp.fromNow !== fromNow)
      needsRefresh = true;
    rsvp.fromNow = fromNow;

    return needsRefresh;
  }

  changeResponse(rsvp, userId, going, zoom, remove) {
    if (remove) {
      rsvp.invited = rsvp.invited.filter(uId => uId !== userId);
      rsvp.yes = rsvp.invited.filter(uId => uId !== userId);
      rsvp.no = rsvp.invited.filter(uId => uId !== userId);
      rsvp.zoom = rsvp.zoom.filter(uId => uId !== userId);
    } else {
      if (!rsvp.invited.includes(userId))
        rsvp.invited.push(userId);

      if (going === true && !rsvp.yes.includes(userId))
        rsvp.yes.push(userId);
      if (going !== true) {
        rsvp.yes = rsvp.yes.filter(uId => uId !== userId);
        rsvp.zoom = rsvp.zoom.filter(uId => uId !== userId);
      }

      if (going === false && !rsvp.no.includes(userId))
        rsvp.no.push(userId);
      if (going !== false)
        rsvp.no = rsvp.no.filter(uId => uId !== userId);

      if (going === true && zoom === true && !rsvp.zoom.includes(userId))
        rsvp.zoom.push(userId);
      if (zoom === false)
        rsvp.zoom = rsvp.zoom.filter(uId => uId !== userId);
    }

    if (!rsvp.changed.includes(userId))
      rsvp.changed.push(userId);
  }

  addInvites(rsvp) {
    let changed = rsvp.changed.length > 0;
    if (rsvp.invite && rsvp.invite !== '') {
      try {
        const { members, color } = this.discord.getRole(rsvp.invite);
        for (const memberId of members) {
          if (!rsvp.invited.includes(memberId)) {
            rsvp.invited.push(memberId);
            changed = true;
          }
        }
      } catch (err) {
        this.log.warn(err, `No such role: ${rsvp.invite}`);
      }
    }

    // Set the posted sticky bit once invites are sent.
    rsvp.posted = true;

    // Always refresh if there are pending invite changes.
    if (changed)
      this.refreshRsvp(rsvp);

    return changed;
  }

  async syncInvites(rsvp, event) {
    const lookup = new Map();
    for (const userId in this.state.accounts) {
      lookup.set(this.state.accounts[userId].toLowerCase(), userId);
    }

    // Get current responses from the RSVP.
    const responses = new Map();
    for (const userId of rsvp.invited) {
      let email = this.state.accounts[userId];
      if (!email) {
        const userName = await this.discord.getNickname(userId);
        email = `discord@${userName}`.toLowerCase().replace(" ", "_");
        lookup.set(email, userId);
      }

      if (rsvp.yes.includes(userId)) {
        responses.set(email, 'accepted');
      } else if (rsvp.no.includes(userId)) {
        responses.set(email, 'declined');
      } else {
        responses.set(email, 'needsAction');
      }
    }

    // Copy attendees from the event to the RSVP.
    const existingAttendees = Object.assign([], event.attendees);
    let attendees = [];
    let updateAttendees = false;
    let refreshRsvp = false;
    for (const attendee of existingAttendees) {
      const email = attendee.email.toLowerCase();
      const userId = lookup.get(email);
      this.log.debug(attendee, `Attendee from event, userId: ${userId}`);
      if (!userId) {
        attendees.push(attendee);
        continue;
      }

      const response = responses.get(email);
      if (rsvp.changed.includes(userId)) {
        if (response) {
          this.log.debug(attendee, `Updating attendee from RSVP: ${response}`);
          attendee.responseStatus = response;
          attendees.push(attendee);
          updateAttendees = true;
        } else {
          this.log.debug(attendee, `Removing attendee from event`);
          updateAttendees = true;
        }
      } else if (attendee.responseStatus !== response) {
        let going = undefined;
        if (attendee.responseStatus === 'accepted') {
          going = true;
        } else if (attendee.responseStatus === 'declined') {
          going = false;
        }

        this.log.debug(attendee, `Updating attendee from event`);
        this.changeResponse(rsvp, userId, going);
        attendees.push(attendee);
        refreshRsvp = true;
      } else {
        attendees.push(attendee);
      }

      responses.delete(email);
      rsvp.changed = rsvp.changed.filter(uId => uId !== userId);
    }

    // Add new attendees from the RSVP.
    for (const [email, response] of responses) {
      this.log.debug(`Attendee ${email} created in Discord as ${response}`);

      attendees.push({
        email: email,
        responseStatus: response
      });
      updateAttendees = true;

      const userId = lookup.get(email);
      if (userId)
        rsvp.changed = rsvp.changed.filter(uId => uId !== userId);
    }

    if (updateAttendees) {
      try {
        await this.calendar.setAttendees(event, attendees);
      } catch (err) {
        this.log.error(err, "Error caught during attendees update");
      }
    }

    if (refreshRsvp)
      this.refreshRsvp(rsvp);
  }

}

module.exports = {
  Bot
};
