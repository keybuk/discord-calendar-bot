const {Client, RichEmbed} = require('discord.js');
const storage = require('node-persist');
const moment = require('moment');
const htmlToText = require('html-to-text');

class Bot {

  constructor(log, config, calendar) {
    this.log = log;
    this.config = config;
    this.calendar = calendar;

    this.client = new Client({
      fetchAllMembers: true,
      sync: true
    });

    this.client.on('ready', () => {
      this.log.info("Discord ready");

      this.yesEmoji = '✅';
      this.noEmoji = '❌';
      this.noResponseEmoji = '😾';

      this.guild = this.client.guilds.first();      
      this.channel = this.guild.channels.find(ch => ch.name === this.config.channel);
      if (!this.channel) {
        this.log.error("Channel not found: %s", this.config.channel);
      }
    });
  }

  async login() {
    await this.client.login(this.config.discordToken);
  }

  async announceEvent(event) {
    this.log.debug(event);
    var rsvp = await storage.getItem('rsvp/' + event.id);
    if (!rsvp) {
      rsvp = {
        'yes': [],
        'no': [],
        'invited': []
      };
    }

    var message;
    if (rsvp.messageId) {
      message = await this.channel.fetchMessage(rsvp.messageId);
    }

    const start = moment(event.start.dateTime || event.start.date);
    const endDate = event.end.dateTime || event.end.date;
    const end = endDate ? moment(endDate) : undefined;

    // Hide messages from the past, and from too far in the future.
    const now = moment();
    if ((end && end < now) || (start.diff(now, 'days') > this.config.limit)) {
      if (message) {
        await message.delete();
        this.log.debug('Deleted');
      }
      return;
    }

    // Parse the description each time looking for keywords.
    var description, image, invite;
    if (event.description) {
      const plainText = htmlToText.fromString(event.description, {
        wordwrap: false,
        ignoreHref: true
      });

      var newLines = [];
      const lines = plainText.split('\n');
      for (const line of lines) {
        if (line.startsWith('image:')) {
          image = line.substring(6).trim();
        } else if (line.startsWith('invite:')) {
          invite = line.substring(7).trim();
        } else {
          newLines.push(line);
        }
      }

      description = newLines.join('\n').trim();
    }

    // Send invites, then look at responses.
    const role = invite ? this.guild.roles.find(r => r.name === invite) : undefined;
    if (invite && !role)
      this.log.warn("No such role: %s". invite);

    if (role) {
      for (var [memberId, member] of role.members) {
        if (!rsvp.invited.includes(memberId))
          rsvp.invited.push(memberId);
      }
    }

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
    content.setTitle(event.summary);
    if (description)
      content.setDescription(description);
    if (image)
      content.setImage(image);
    if (role)
      content.setColor(role.color);

    content.addField('When', this.eventTime(start, end));
    content.addField('Going', `${this.yesEmoji} ${yes.join(' ')}`);
    content.addField('Not Going', `${this.noEmoji} ${no.join(' ')}`);
    content.addField('No Response', `${this.noResponseEmoji} ${no_response.join(' ')}`);

    content.setFooter(start.fromNow(), 'https://www.gstatic.com/images/branding/product/2x/calendar_48dp.png');

    if (message) {
      message = await message.edit(content);
      this.log.debug('Edited');
    } else {
      message = await this.channel.send(content);
      this.log.debug('Announced');
    }

    rsvp.messageId = message.id;
    await storage.setItem('rsvp/' + event.id, rsvp);

    await message.react(this.yesEmoji);
    await message.react(this.noEmoji);
  }

  sendInvites(rsvp, role) {

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

}

module.exports = {
  Bot,
};
