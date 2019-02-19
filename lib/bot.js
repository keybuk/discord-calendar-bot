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
  }

  start() {
    if (this.intervalTimeout)
      return;

    setImmediate(() => {
      this.update()
        .catch(err => { this.log.error(err, "Error in first update") });
    });
    this.intervalTimeout = setInterval(() => {
      this.update()
        .catch(err => { this.log.error(err, "Error in update") });
    }, this.config.refreshInterval);
  }

  async update() {
    var updatedEvents = {};

    await this.calendar.updateEvents(async event => {
      const rsvp = await this.updateRsvp(event);
      if (!rsvp.cancelled) {
        await this.syncInvites(rsvp, event);
        await this.discord.updateMessage(rsvp);
        await this.saveRsvp(rsvp);
      } else {
        await this.discord.updateMessage(rsvp);
        await this.deleteRsvp(rsvp);
      }

      updatedEvents[event.id] = true;
    }).catch(err => { this.log.error(err, "Error during calendar sync") });

    const rsvps = await storage.valuesWithKeyMatch(/^rsvp\//);
    for (const rsvp of rsvps) {
      this.fixRsvpTypes(rsvp);

      if (updatedEvents[rsvp.eventId] !== 1) {
        await this.syncInvites(rsvp, event);
      }
      if (this.refreshRsvp(rsvp)) {
        this.log.info(rsvp, "RSVP needs refresh");
        await this.discord.updateMessage(rsvp);
        await this.saveRsvp(rsvp);
      }
    }
  }

  stop() {
    clearInterval(this.intervalTimeout);
    this.intervalTimeout = undefined;
  }

  async getRsvp(eventId) {
    var rsvp = await storage.getItem('rsvp/' + eventId);
    if (rsvp)
      this.fixRsvpTypes(rsvp);
    return rsvp;
  }

  fixRsvpTypes(rsvp) {
    if (rsvp.start)
      rsvp.start = moment(rsvp.start);
    if (rsvp.end)
      rsvp.end = moment(rsvp.end);

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
        'invited': []
      };
    }

    if (event.status === 'cancelled') {
      rsvp.cancelled = true;
      return;
    }

    rsvp.start = moment(event.start.dateTime || event.start.date);
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
          rsvp.invite = line.substring(7).trim();
        } else {
          newLines.push(line);
        }
      }

      rsvp.description = newLines.join('\n').trim();
    }

    // Add invites based on roles.
    if (rsvp.invite) {
      try {
        const {members, color} = this.discord.getRole(rsvp.invite);
        for (var memberId of members) {
          if (!rsvp.invited.includes(memberId))
            rsvp.invited.push(memberId);
        }
        rsvp.color = color;
      } catch(err) {
        this.log.warn("No such role: %s". rsvp.invite);
      }
    }

    this.refreshRsvp(rsvp);

    return rsvp;
  }

  refreshRsvp(rsvp) {
    var needsRefresh = false;

    const now = moment();
    let hide;
    if (rsvp.end && rsvp.end < now)
      // Hide any event once its passed.
      hide = true;
    else if (rsvp.invite)
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

    let fromNow = rsvp.start.fromNow();
    if (rsvp.fromNow !== fromNow)
      needsRefresh = true;
    rsvp.fromNow = fromNow;

    return needsRefresh;
  }

  changeRsvp(rsvp, userId, going) {
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

  async syncInvites(rsvp, event) {
    const accounts = await storage.getItem('googleAccounts');
    if (!accounts)
      return;

    var responses = {};
    for (const email in accounts) {
      const userId = accounts[email];

      if (rsvp.yes.includes(userId)) {
        responses[email] = "accepted";
      } else if (rsvp.no.includes(userId)) {
        responses[email] = "declined";
      } else if (rsvp.invited.includes(userId)) {
        responses[email] = "needsAction";
      }
    }

    this.log.debug(responses, `Responses from RSVP`);

    // Load a second separate copy of the cached event to compare.
    const cachedEvent = await this.calendar.cachedEvent(event.id);
    var oldResponses = {};
    if (cachedEvent.attendees) {
      for (const attendee of cachedEvent.attendees) {
        oldResponses[attendee.email] = attendee.responseStatus;
      }
    }

    this.log.debug(oldResponses, `Responses from cached event`);

    // Copy changed attendees from the event.
    var attendees = Object.assign([], event.attendees);
    var changed = false;
    for (const attendee of attendees) {
      const userId = accounts[attendee.email];
      this.log.debug(attendee, `Attendee from event, userId: ${userId}`);
      if (!userId)
        continue;

      // If the calendar event changed, push to the RSVP,
      // otherwise see if we need to update from it.
      const oldResponse = oldResponses[attendee.email];
      if (attendee.responseStatus !== oldResponse) {
        var going = undefined;
        if (attendee.responseStatus === 'accepted') {
          this.log.debug(`Accepted in calendar`);
          going = true;
        } else if (attendee.responseStatus === 'declined') {
          this.log.debug(`Declined in calendar`);
          going = false;
        }

        this.changeRsvp(rsvp, userId, going);
      } else {
        const response = responses[attendee.email];
        if (attendee.responseStatus !== response) {
          this.log.debug(`Response set to ${response} in Discord`);
          attendee.responseStatus = response;
          changed = true;
        }
        delete responses[attendee.email];
      }
    }

    // Add new attendee objects.
    for (const email in responses) {
      this.log.debug(`Attendee ${email} created in Discord as ${responses[email]}`);
      event.attendees.push({
        email: email,
        responseStatus: responses[email]
      });
      changed = true;
    }

    if (changed)
      await this.calendar.setAttendees(event, attendees);
  }

  async rsvp(eventId, userId, going) {
    var rsvp = await this.getRsvp(eventId);
    if (rsvp) {
      this.changeRsvp(rsvp, userId, going);

      if (rsvp.messageId)
        await this.discord.updateMessage(rsvp);

      await this.saveRsvp(rsvp);
    }
  }

}

module.exports = {
  Bot
};