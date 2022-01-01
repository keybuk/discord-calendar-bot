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
    await this.updateCalendarEvents()
      .catch(err => { this.log.error(err, "Error during calendar sync") });
    await this.refreshAllRsvp(firstRun)
      .catch(err => { this.log.error(err, "Error during rsvp refresh") });
  }

  async updateCalendarEvents() {
    await this.calendar.updateEvents(async event => {
      const rsvp = await this.updateRsvp(event);
      if (!rsvp.cancelled && !rsvp.past) {
        // Add invites to any rsvp we would announce, and then sync
        // invites from the event to the rsvp and updating the event.
        if (!rsvp.hide)
          this.addInvites(rsvp);
        try {
          await this.syncInvites(rsvp, event);
          await this.discord.updateMessage(rsvp);
        } finally {
          await this.saveRsvp(rsvp);
        }
      } else {
        try {
          await this.discord.updateMessage(rsvp);
        } finally {
          await this.deleteRsvp(rsvp);
        }
      }
    });
  }

  async refreshAllRsvp(firstRun) {
    await this.findNextEvents();

    await this.foreachRsvp(async rsvp => {
      let needsUpdate = false;
      // Sync reactions to messages when we first run.
      if (firstRun)
        await this.discord.syncReactions(rsvp);
      // Refresh rsvp properties.
      if (this.refreshRsvp(rsvp)) {
        this.log.info(rsvp, "RSVP needs refresh");
        needsUpdate = true;
      }
      // Add invites to any rsvp we would announce, and then sync invites
      // from the event (which means a fetch).
      if (!rsvp.past && !rsvp.hide && this.addInvites(rsvp)) {
        this.log.info(rsvp, "Invites needs sync");
        const event = await this.calendar.getEvent(rsvp.eventId);
        await this.syncInvites(rsvp, event);
        needsUpdate = true;
      }
      // Update the message and save the updated rsvp entry.
      if (needsUpdate || firstRun) {
        try {
          await this.discord.updateMessage(rsvp);
        } finally {
          if (rsvp.past) {
            await this.deleteRsvp(rsvp);
          } else {
            await this.saveRsvp(rsvp);
          }
        }
      }
    });
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
    let rsvp = await this.rsvpStorage.getItem(eventId);
    if (rsvp)
      this.fixRsvpTypes(rsvp);
    return rsvp;
  }

  async foreachRsvp(callback) {
    const rsvps = await this.rsvpStorage.values();
    for (const rsvp of rsvps) {
      this.fixRsvpTypes(rsvp);
      if (!rsvp.cancelled)
        await callback(rsvp);
    }
  }

  async findNextEvents() {
    let roles = {};
    const now = moment();
    const rsvps = await this.rsvpStorage.values();

    for (const rsvp of rsvps) {
      this.fixRsvpTypes(rsvp);

      if (!rsvp.cancelled &&
        rsvp.end && rsvp.end > now &&
        rsvp.invite && rsvp.invite !== '' &&
        (!roles[rsvp.invite] || (roles[rsvp.invite].start > rsvp.start))) {
        roles[rsvp.invite] = rsvp;
      }
    }

    for (const role in roles) {
      let rsvp = roles[role];
      if (!rsvp.invited.length) {
        this.log.debug(rsvp, `Next event for ${role}, will send invites`);
        this.addInvites(rsvp);
        await this.saveRsvp(rsvp);
      }
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
    if (!rsvp.zoom)
      rsvp.zoom = [];

    return rsvp;
  }

  async saveRsvp(rsvp) {
    delete rsvp.significantChange;
    await this.rsvpStorage.setItem(rsvp.eventId, rsvp);
  }

  async deleteRsvp(rsvp) {
    await this.rsvpStorage.removeItem(rsvp.eventId);
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
          let invite = line.substring(7).trim().toLowerCase();
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

    this.refreshRsvp(rsvp);

    return rsvp;
  }

  addInvites(rsvp) {
    let changed = false;
    if (rsvp.invite && rsvp.invite !== '') {
      try {
        const { members, color } = this.discord.getRole(rsvp.invite);
        for (let memberId of members) {
          if (!rsvp.invited.includes(memberId)) {
            rsvp.invited.push(memberId);
            changed = true;
          }
        }
      } catch (err) {
        this.log.warn("No such role: %s", rsvp.invite);
      }
    }

    // Always refresh if there are pending invite changes.
    return changed;
  }

  refreshRsvp(rsvp) {
    let needsRefresh = false;

    // Set the color based on the role.
    if (!rsvp.color && rsvp.invite && rsvp.invite !== '') {
      try {
        const { members, color } = this.discord.getRole(rsvp.invite);
        rsvp.color = color;
        needsRefresh = true;
      } catch (err) {
        this.log.warn("No such role: %s", rsvp.invite);
      }
    }

    const now = moment();
    let hide, past = false;
    if (rsvp.end && rsvp.end < now) {
      // Hide any event once its passed.
      hide = true;
      past = true;
    } else if (rsvp.invited.length)
      // Always show events once invites are sent out.
      hide = false;
    else if (rsvp.start.diff(now, 'days') > this.config.limit)
      // Otherwise hide events in the far future.
      hide = true;
    else
      hide = false;

    if (rsvp.hide !== hide)
      needsRefresh = true;
    rsvp.hide = hide;

    if (rsvp.past !== past)
      needsRefresh = true;
    rsvp.past = past;

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

  changeRsvp(rsvp, userId, going, zoom, remove) {
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
    let attendees = [];
    let existingAttendees = Object.assign([], event.attendees);
    let updateAttendees = false;
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

        this.log.debug(attendee, `Updating RSVP from event`);
        this.changeRsvp(rsvp, userId, going);
        attendees.push(attendee);
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

    if (updateAttendees)
      await this.calendar.setAttendees(event, attendees);
  }

  async rsvp(eventId, userId, going, zoom, remove) {
    let rsvp = await this.getRsvp(eventId);
    if (rsvp) {
      this.changeRsvp(rsvp, userId, going, zoom, remove);

      if (rsvp.messageId)
        await this.discord.updateMessage(rsvp);

      await this.saveRsvp(rsvp);
    }
  }

}

module.exports = {
  Bot
};
