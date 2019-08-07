'use strict';
const storage = require('node-persist');
const moment = require('moment');
const htmlToText = require('html-to-text');

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
  }

  start() {
    if (this.intervalTimeout)
      return;

    this.loadState()
      .catch(err => { this.log.error(err, "Error loading state") });

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
    await this.calendar.updateEvents(async event => {
      const rsvp = await this.updateRsvp(event);
      if (!rsvp.cancelled && !rsvp.past) {
        await this.syncInvites(rsvp, event);
        await this.discord.updateMessage(rsvp);
        await this.saveRsvp(rsvp);
      } else {
        await this.discord.updateMessage(rsvp);
        await this.deleteRsvp(rsvp);
      }
    }).catch(err => { this.log.error(err, "Error during calendar sync") });

    await this.foreachRsvp(async rsvp => {
      var needsSave = false;
      if (firstRun)
        await this.discord.syncReactions(rsvp);
      if (!rsvp.past && this.refreshInvites(rsvp)) {
        this.log.info(rsvp, "Invites needs sync");
        const event = await this.calendar.getEvent(rsvp.eventId);
        await this.syncInvites(rsvp, event);
        needsSave = true;
      }
      if (firstRun || this.refreshRsvp(rsvp)) {
        this.log.info(rsvp, "RSVP needs refresh");
        await this.discord.updateMessage(rsvp);
        needsSave = true;
      }
      if (needsSave)
        await this.saveRsvp(rsvp);
    }).catch(err => { this.log.error(err, "Error during rsvp refresh") });
  }

  stop() {
    clearInterval(this.intervalTimeout);
    this.intervalTimeout = undefined;
    this.saveState()
      .catch(err => { this.log.error(err, "Error saving state") });
  }

  async loadState() {
    var state = await storage.getItem('state');
    if (state)
      this.state = state;
  }

  async saveState() {
    await storage.setItem('state', this.state);
  }

  async getRsvp(eventId) {
    var rsvp = await storage.getItem('rsvp/' + eventId);
    if (rsvp)
      this.fixRsvpTypes(rsvp);
    return rsvp;
  }

  async foreachRsvp(callback) {
    const rsvps = await storage.valuesWithKeyMatch(/^rsvp\//);
    for (const rsvp of rsvps) {
      this.fixRsvpTypes(rsvp);
      if (!rsvp.cancelled)
        callback(rsvp);
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

    return rsvp;
  }

  async saveRsvp(rsvp) {
    await storage.setItem('rsvp/' + rsvp.eventId, rsvp);
  }

  async deleteRsvp(rsvp) {
    await storage.removeItem('rsvp/' + rsvp.eventId);
  }

  async updateRsvp(event) {
    this.log.debug(event, "Update RSVP from event");
    var rsvp = await this.getRsvp(event.id);
    if (!rsvp) {
      rsvp = {
        'eventId': event.id,
        'yes': [],
        'no': [],
        'invited': [],
        'changed': []
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
      var plainText;
      if (event.description.includes('<')) {
        plainText = htmlToText.fromString(event.description, {
          wordwrap: false,
          ignoreHref: true
        });
      } else {
        plainText = event.description.trim();
      }

      var newLines = [];
      const lines = plainText.split('\n');
      for (const line of lines) {
        if (line.toLowerCase().startsWith('image:')) {
          rsvp.image = line.substring(6).trim();
        } else if (line.toLowerCase().startsWith('invite:')) {
          rsvp.invite = line.substring(7).trim().toLowerCase();
        } else {
          newLines.push(line);
        }
      }

      rsvp.description = newLines.join('\n').trim();
    }

    this.refreshRsvp(rsvp);

    return rsvp;
  }

  refreshInvites(rsvp) {
    if (rsvp.invite && rsvp.invite !== '') {
      try {
        const {members, color} = this.discord.getRole(rsvp.invite);
        for (var memberId of members) {
          if (!rsvp.invited.includes(memberId)) {
            rsvp.invited.push(memberId);
            if (!rsvp.changed.includes(memberId))
              rsvp.changed.push(memberId);
          }
        }
      } catch(err) {
        this.log.warn("No such role: %s", rsvp.invite);
      }
    }

    // Always refresh if there are pending invite changes.
    return rsvp.changed.length > 0;
  }

  refreshRsvp(rsvp) {
    var needsRefresh = false;

    // Set the color based on the role.
    if (!rsvp.color && rsvp.invite && rsvp.invite !== '') {
      try {
        const {members, color} = this.discord.getRole(rsvp.invite);
        rsvp.color = color;
        needsRefresh = true;
      } catch(err) {
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
    if (rsvp.fromNow !== fromNow)
      needsRefresh = true;
    rsvp.fromNow = fromNow;

    return needsRefresh;
  }

  changeRsvp(rsvp, userId, going, remove) {
    if (remove) {
      rsvp.invited = rsvp.invited.filter(uId => uId !== userId);
      rsvp.yes = rsvp.invited.filter(uId => uId !== userId);
      rsvp.no = rsvp.invited.filter(uId => uId !== userId);
    } else {
      if (!rsvp.invited.includes(userId))
        rsvp.invited.push(userId);

      if (going === true && !rsvp.yes.includes(userId))
        rsvp.yes.push(userId);
      if (going !== true)
        rsvp.yes = rsvp.yes.filter(uId => uId !== userId);

      if (going === false && !rsvp.no.includes(userId))
        rsvp.no.push(userId);
      if (going !== false)
        rsvp.no = rsvp.no.filter(uId => uId !== userId);
    }

    if (!rsvp.changed.includes(userId))
      rsvp.changed.push(userId);
  }

  async syncInvites(rsvp, event) {
    var lookup = {};
    for (const userId in this.state.accounts) {
      lookup[this.state.accounts[userId]] = userId;
    }

    // Get current responses from the RSVP.
    var responses = {};
    for (const userId of rsvp.invited) {
      var email = this.state.accounts[userId];
      if (!email) {
        const userName = await this.discord.getNickname(userId);
        email = `discord@${userName}`.toLowerCase();
        lookup[email] = userId;
      }

      if (rsvp.yes.includes(userId)) {
        responses[email] = "accepted";
      } else if (rsvp.no.includes(userId)) {
        responses[email] = "declined";
      } else {
        responses[email] = "needsAction";
      }
    }

    this.log.debug(responses, `Responses from RSVP`);

    // Copy attendees from the event to the RSVP.
    var attendees = [];
    var existingAttendees = Object.assign([], event.attendees);
    var updateAttendees = false;
    for (const attendee of existingAttendees) {
      const email = attendee.email.toLowerCase();
      const userId = lookup[email];
      this.log.debug(attendee, `Attendee from event, userId: ${userId}`);
      if (!userId) {
        attendees.push(attendee);
        continue;
      }

      if (rsvp.changed.includes(userId)) {
        const response = responses[email];
        if (response) {
          this.log.debug(attendee, `Updating attendee from RSVP: ${responses[email]}`);
          attendee.responseStatus = responses[email];
          attendees.push(attendee);
          updateAttendees = true;
        } else {
          this.log.debug(attendee, `Removing attendee from event`);
          updateAttendees = true;
        }
      } else if (attendee.responseStatus !== responses[email]) {
        var going = undefined;
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

      delete responses[email];
      rsvp.changed = rsvp.changed.filter(uId => uId !== userId);
    }

    // Add new attendees from the RSVP.
    for (const email in responses) {
      this.log.debug(`Attendee ${email} created in Discord as ${responses[email]}`);

      attendees.push({
        email: email,
        responseStatus: responses[email]
      });
      updateAttendees = true;

      const userId = lookup[email];
      if (userId)
        rsvp.changed = rsvp.changed.filter(uId => uId !== userId);
    }

    if (updateAttendees)
      await this.calendar.setAttendees(event, attendees);
  }

  async rsvp(eventId, userId, going, remove) {
    var rsvp = await this.getRsvp(eventId);
    if (rsvp) {
      this.changeRsvp(rsvp, userId, going, remove);

      if (rsvp.messageId)
        await this.discord.updateMessage(rsvp);

      await this.saveRsvp(rsvp);
    }
  }

}

module.exports = {
  Bot
};