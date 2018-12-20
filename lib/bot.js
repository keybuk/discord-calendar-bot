const {Client, RichEmbed} = require('discord.js');
const storage = require('node-persist');
const moment = require('moment');
const htmlToText = require('html-to-text');

class Bot {

  constructor(log, config, calendar) {
    this.log = log;
    this.config = config;
    this.calendar = calendar;

    calendar.bot = this;

    this.client = new Client({
      /*fetchAllMembers: true,
      sync: true*/
    });

    this.client.on('ready', () => {
      this.log.info("Discord ready");

      this.yesEmoji = '✅';
      this.noEmoji = '❌';
      this.noResponseEmoji = '😾';

      this.guild = this.client.guilds.first();
      this.log.debug(this.guild, "Guild found");

      this.channel = this.guild.channels.find(ch => ch.name === this.config.channel);
      if (this.channel) {
        this.log.debug(this.channel, "Channel found");
      } else {
        this.log.error("Channel not found: %s", this.config.channel);
      }
    });

    this.client.on('message', message => {
      if (message.author.bot)
        return;
      if (!message.content.startsWith(this.config.prefix))
        return;

      const args = message.content.slice(this.config.prefix.length).trim().split(/ +/g);
      const command = args.shift().toLowerCase();

      if (command === 'google') {
        this.googleCommand(command, args, message)
          .catch(err => this.log.error(err, "Error caught during message"));
      }

      if (command === 'rsvp') {
        this.rsvpCommand(command, args, message)
          .catch(err => this.log.error(err, "Error caught during message"));
      }
    });

    this.client.on('messageReactionAdd', (reaction, user) => {
      if (user === this.client.user)
        return;

      this.log.debug({reaction, user}, "messageReactionAdd")
      this.reactionAdded(reaction, user)
        .catch(err => this.log.error(err, "Error caught during messageReactionAdd"));
    });
  }

  async login() {
    await this.client.login(this.config.discordToken);
    this.log.debug("Login complete");
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

  async announceEvent(event) {
    this.log.debug(event);
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

    // Hide messages from the past, and from too far in the future.
    const now = moment();
    rsvp.hide = (rsvp.end && rsvp.end < now)
        || (rsvp.start.diff(now, 'days') > this.config.limit);

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
      const role = this.guild.roles.find(r => r.name === rsvp.invite);
      if (role) {
        for (var [memberId, member] of role.members) {
          if (!rsvp.invited.includes(memberId))
            rsvp.invited.push(memberId);
        }

        rsvp.color = role.color;
        rsvp.hide = false;
      } else {
        this.log.warn("No such role: %s". invite);
      }
    }

    await this.syncInvites(event, rsvp);
    await this.sendRsvpMessage(event.id, rsvp);
  }

  eventTime(start, end) {
    const allDay = start.isSame(start.clone().startOf('date'))
      && (!end || end.isSame(end.clone().startOf('date')));
    const precise = (start.seconds() > 0) || (end && (end.seconds() > 0));

    if (end && !start.isSame(end)) {
      if (start.isSame(end, 'day')) {
        if (allDay) {
          return start.format('dddd, MMMM Do YYYY');
        } else if (precise) {
          return start.format('dddd, MMMM Do YYYY h:mm:ss a') + '—'
              + end.format('h:mm:ss a');
        } else {
          return start.format('dddd, MMMM Do YYYY h:mm a') + '—'
              + end.format('h:mm a');
        }

      } else {
        if (allDay) {
          return start.format('dddd, MMMM Do YYYY') + '—'
              + end.format('dddd, MMMM Do YYYY');
        } else if (precise) {
          return start.format('dddd, MMMM Do YYYY h:mm:ss a') + '—'
              + end.format('dddd, MMMM Do YYYY h:mm:ss a');
        } else {
          return start.format('dddd, MMMM Do YYYY h:mm a') + '—'
              + end.format('dddd, MMMM Do YYYY h:mm a');
        }
      }
    } else {
      if (allDay) {
        return start.format('dddd, MMMM Do YYYY');
      } else if (precise) {
        return start.format('dddd, MMMM Do YYYY h:mm:ss a');
      } else {
        return start.format('dddd, MMMM Do YYYY h:mm a');
      }
    }
  }

  async sendRsvpMessage(eventId, rsvp) {
    this.log.debug(rsvp);

    // Fetch the existing message.
    var message;
    if (rsvp.messageId) {
      message = await this.channel.fetchMessage(rsvp.messageId);
    }

    // Don't send a message if we're hiding it, and delete if necessary.
    if (rsvp.hide) {
      if (message) {
        await message.delete();
        await storage.deleteItem('rsvp-to/' + rsvp.messageId);
        this.log.debug('Deleted');
      }
      return;
    }

    // Turn the RSVP list into mentions.
    var yes = [], no = [], no_response = [];
    for (var userId of rsvp.invited) {
      const member = await this.guild.fetchMember(userId);

      if (rsvp.yes.includes(userId)) {
        yes.push(`${member}`);
      } else if (rsvp.no.includes(userId)) {
        no.push(`${member}`);
      } else {
        no_response.push(`${member}`);
      }
    }

    // Build the message.
    var content = new RichEmbed();
    content.setTitle(rsvp.title);
    if (rsvp.description)
      content.setDescription(rsvp.description);
    if (rsvp.image)
      content.setImage(rsvp.image);
    if (rsvp.color)
      content.setColor(rsvp.color);

    content.addField('When', this.eventTime(rsvp.start, rsvp.end));
    if (rsvp.location)
      content.addField('Where', rsvp.location);
    content.addField('Going', `${this.yesEmoji} ${yes.join(' ')}`);
    content.addField('Not Going', `${this.noEmoji} ${no.join(' ')}`);
    content.addField('No Response', `${this.noResponseEmoji} ${no_response.join(' ')}`);

    content.setFooter(rsvp.start.fromNow(), 'https://www.gstatic.com/images/branding/product/2x/calendar_48dp.png');

    if (message) {
      message = await message.edit(content);
      this.log.debug('Edited');
    } else {
      message = await this.channel.send(content);
      this.log.debug('Announced');
    }

    rsvp.messageId = message.id;
    await storage.setItem('rsvp/' + eventId, rsvp);
    await storage.setItem('rsvp-to/' + message.id, eventId);

    await message.react(this.yesEmoji);
    await message.react(this.noEmoji);
  }

  async reactionAdded(reaction, user) {
    const eventId = await storage.getItem('rsvp-to/' + reaction.message.id);
    if (!eventId)
      return;

    if (reaction.emoji.name === this.yesEmoji) {
      this.log.info(`${user} is going to ${eventId}`);
      await this.rsvp(eventId, user.id, true);
    } else if (reaction.emoji.name === this.noEmoji) {
      this.log.info(`${user} is not going to ${eventId}`);
      await this.rsvp(eventId, user.id, false);
    } else {
      this.log.info(`${user} added unknown reaction ${reaction.emoji}`);
    }

    await reaction.remove(user);
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
      await this.sendRsvpMessage(eventId, rsvp);
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

  async googleCommand(command, args, message) {
    var accounts = await storage.getItem('googleAccounts');
    if (!accounts)
      accounts = {};

    const mentioned = message.mentions.users.first();
    const who = mentioned || message.author;
    const youStr = mentioned ? `${mentioned}` : 'you';
    const youreStr = mentioned ? `${mentioned} isn't` : 'You\'re';

    var currentEmail;
    for (const email in accounts) {
      if (accounts[email] === who.id)
        currentEmail = email;
    }

    if (args.slice(-1)[0].startsWith('@'))
      args.pop();
    const email = args.shift();

    if (!email) {
      if (currentEmail) {
        return message.reply(`I'm inviting ${youStr} to events on \`${currentEmail}\`. Provide a new address or \`off\` to change that.`);
      } else {
        return message.reply(`${youreStr} not getting calendar invites to events. Provide a Google account e-mail address or \`off\``);
      }
    } else if (email === 'off') {
      if (currentEmail) {
        delete accounts[currentEmail];
        await storage.setItem('googleAccounts', accounts);
        return message.reply(`Okay, I won't invite ${youStr} on Google Calendar anymore.`);
      } else {
        return message.reply(`I wasn't inviting ${youStr} to events on Google Calendar anyway!`);
      }
    } else {
      accounts[email] = who.id;
      await storage.setItem('googleAccounts', accounts);
      return message.reply(`Okay! I'll invite ${youStr} to events on Google Calendar using \`${email}\` from now on.`);
    }
  }

  async rsvpCommand(command, args, message) {
    if (args.slice(-1)[0].startsWith('@'))
      args.pop();
    const eventId = args.shift();
    const response = args.shift().toLowerCase();

    const mentioned = message.mentions.users.first();
    const who = mentioned || message.author;
    const youStr = mentioned ? `${mentioned}` : 'you';

    var going;
    if (!response || response === 'yes') {
      going = true;
    } else if (response === 'no') {
      going = false;
    } else if (response === 'undecided') {
      going = undefined;
    } else {
      return message.reply("RSVP with `yes`, `no`, or `undecided`.");
    }

    await this.rsvp(eventId, who.id, true);

    const rsvp = await this.getRsvp(eventId);
    const eventTitle = rsvp.title || `${eventId}`;
    return message.reply(`Okay, I've marked ${youStr} as going to ${eventTitle}`);
  }

}

module.exports = {
  Bot,
};
