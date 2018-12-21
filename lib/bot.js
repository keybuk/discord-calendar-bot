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

    setImmediate(() => { this.update() })
    this.intervalTimeout = setInterval(() => { this.update() },
                                       this.config.refreshInterval)
  }

  update() {
    this.calendar.updateEvents(async event => {
      await this.updateRsvp(event);
      // always announce
      await this.syncInvites(event, rsvp);
      await this.bot.updateMessage(event.id, rsvp);

      await this.discord.announceEvent(event)
    }).catch(err => { this.log.error(err, "Error during calendar sync") });

    // TODO refresh existing events rsvp from cache only
    // update message if fromNow changes
    // update message if hide changes
  }

  stop() {
    clearInterval(this.intervalTimeout);
    this.intervalTimeout = undefined;
  }

  async getRsvp(eventId) {
    var rsvp = await storage.getItem('rsvp/' + eventId);
    if (rsvp) {
      if (rsvp.start)
        rsvp.start = moment(rsvp.start);
      if (rsvp.end)
        rsvp.end = moment(rsvp.end);
    }

    return rsvp;
  }

  adjustRsvp(rsvp, userId, going) {
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

  async rsvp(eventId, userId, going) {
    var rsvp = await this.getRsvp(eventId);

    this.adjustRsvp(rsvp, userId, going);
    await storage.setItem('rsvp/' + eventId, rsvp);

    await this.syncInvites(eventId, rsvp);

    if (rsvp.messageId)
      await this.discord.updateMessage(eventId, rsvp);
  }

  async updateRsvp(event) {
    this.log.debug(event, "Update event");
    var rsvp = await this.getRsvp(event.id);
    if (!rsvp) {
      rsvp = {
        'yes': [],
        'no': [],
        'invited': []
      };
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
        if (line.startsWith('image:')) {
          rsvp.image = line.substring(6).trim();
        } else if (line.startsWith('invite:')) {
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

    const now = moment();
    if (rsvp.end && rsvp.end < now)
      // Hide any event once its passed.
      rsvp.hide = true;
    else if (rsvp.invite)
      // Always show events once invites are sent out.
      rsvp.hide = false;
    else if (rsvp.start.diff(now, 'days') > this.config.limit)
      // Otherwise hide events in the far future.
      rsvp.hide = true;
    else
      rsvp.hide = false;

    rsvp.fromNow = rsvp.start.fromNow();

    return rsvp;
  }

  async syncInvites(event, rsvp) {
    const accounts = await storage.getItem('googleAccounts');
    if (!accounts)
      return;

    // Copy attendees from the event to the RSVP.
    if (event.attendees) {
      for (const attendee of event.attendees) {
        const userId = accounts[attendee.email];
        this.log.debug(attendee, `Attendee from event, userId: ${userId}`);
        if (!userId)
          continue;

        var going = undefined;
        if (attendee.responseStatus === 'accepted') {
          going = true;
        } else if (attendee.responseStatus === 'declined') {
          going = false;
        }

        // BUG? this is never saved!
        this.adjustRsvp(rsvp, userId, going);
      }
    }

    // Copy attendees from the RSVP to the event.
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

    await this.calendar.setResponses(event, responses);
  }

}

module.exports = {
  Bot
};