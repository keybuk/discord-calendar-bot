const {Client, RichEmbed} = require('discord.js');
const storage = require('node-persist');
const moment = require('moment');

class Discord {

  constructor(log, config, calendar) {
    this.log = log;
    this.config = config;
    this.calendar = calendar;

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
      // this.log.debug(this.guild, "Guild found");

      this.channel = this.guild.channels.find(ch => ch.name === this.config.channel);
      if (this.channel) {
        // this.log.debug(this.channel, "Channel found");
        ;
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

      if (command === 'list') {
        this.listCommand(command, args, message)
          .catch(err => this.log.error(err, "Error caught during message"));
      }
    });

    this.client.on('messageReactionAdd', (reaction, user) => {
      if (user === this.client.user)
        return;

      // this.log.debug({reaction, user}, "messageReactionAdd")
      this.reactionAdded(reaction, user)
        .catch(err => this.log.error(err, "Error caught during messageReactionAdd"));
    });

    // Fix for messageReactionAdd not being spawned for old messages.
    const events = {
      MESSAGE_REACTION_ADD: 'messageReactionAdd',
      MESSAGE_REACTION_REMOVE: 'messageReactionRemove',
    };

    this.client.on('raw', async event => {
      if (!events.hasOwnProperty(event.t)) return;

      const { d: data } = event;
      const user = this.client.users.get(data.user_id);
      const channel = this.client.channels.get(data.channel_id) || await user.createDM();

      if (channel.messages.has(data.message_id)) return;

      const message = await channel.fetchMessage(data.message_id);
      const emojiKey = (data.emoji.id) ? `${data.emoji.name}:${data.emoji.id}` : data.emoji.name;
      const reaction = message.reactions.get(emojiKey);

      this.client.emit(events[event.t], reaction, user);
      if (message.reactions.size === 1) message.reactions.delete(emojiKey);
    });

  }

  async login() {
    await this.client.login(this.config.discordToken);
    this.log.debug("Login complete");
  }

  getRole(name) {
    const role = this.guild.roles.find(r => r.name.toLowerCase() === name.toLowerCase());
    if (role)
      return {members: role.members.keys(), color: role.color};
  }

  async getNickname(userId) {
    const user = await this.client.fetchUser(userId);
    const member = await this.guild.fetchMember(user);
    if (member.nickname) {
      return member.nickname;
    } else {
      return user.username;
    }
  }

  eventTime(start, end) {
    const allDay = start.isSame(start.clone().startOf('date'))
      && (!end || end.isSame(end.clone().startOf('date')));
    const precise = (start.seconds() > 0) || (end && (end.seconds() > 0));

    // For all-day events, the end date is shown as midnight of the next day,
    // move that back one for our purposes.
    if (allDay && end) {
      end = end.clone();
      end.subtract(1, 'days');
    }

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

  async syncReactions(rsvp) {
    this.log.debug(rsvp, "Checking for reactions");

    var message;
    if (rsvp.messageId) {
      message = await this.channel.fetchMessage(rsvp.messageId);
    } else {
      return;
    }

    // Clear any existing reactions.
    if (message && message.reactions) {
      for (const reaction of message.reactions.array()) {
        const users = await reaction.fetchUsers();
        for (const user of users.array()) {
          if (user !== this.client.user) {
            this.log.debug({ reaction: reaction.emoji.name, user: user.id }, "Handling extra reaction");
            await this.reactionAdded(reaction, user);
          }
        }
      }
    }
  }

  async updateMessage(rsvp) {
    this.log.debug(rsvp, "Update message");

    // Fetch the existing message.
    var message;
    if (rsvp.messageId)
      message = await this.channel.fetchMessage(rsvp.messageId);

    // Don't send a message if we're hiding it, and delete if necessary.
    if (rsvp.hide || rsvp.cancelled) {
      if (message) {
        await message.delete();
        await storage.removeItem('rsvp-to/' + rsvp.messageId);
        rsvp.messageId = undefined;
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

    content.setFooter(rsvp.fromNow, 'https://www.gstatic.com/images/branding/product/2x/calendar_48dp.png');

    if (message) {
      message = await message.edit(content);
      this.log.debug('Edited');
    } else {
      message = await this.channel.send(content);
      this.log.debug('Announced');
    }

    rsvp.messageId = message.id;
    await storage.setItem('rsvp-to/' + message.id, rsvp.eventId);

    await message.react(this.yesEmoji);
    await message.react(this.noEmoji);
  }

  async reactionAdded(reaction, user) {
    const eventId = await storage.getItem('rsvp-to/' + reaction.message.id);
    if (!eventId)
      return;

    if (reaction.emoji.name === this.yesEmoji) {
      this.log.info(`${user} is going to ${eventId}`);
      await this.bot.rsvp(eventId, user.id, true);
    } else if (reaction.emoji.name === this.noEmoji) {
      this.log.info(`${user} is not going to ${eventId}`);
      await this.bot.rsvp(eventId, user.id, false);
    } else if (reaction.emoji.name === this.noResponseEmoji) {
      await this.bot.rsvp(eventId, user.id, undefined);
    } else {
      this.log.info(`${user} added unknown reaction ${reaction.emoji}`);
    }

    await reaction.remove(user);
  }

  async googleCommand(command, args, message) {
    var accounts = await storage.getItem('googleAccounts');
    if (!accounts)
      accounts = {};

    const mentioned = message.mentions.users.first();
    const who = mentioned || message.author;
    const youStr = mentioned ? `${mentioned}` : 'you';
    const youreStr = mentioned ? `${mentioned} isn't` : 'You\'re';

    var currentEmail = accounts[who.id];

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
        delete accounts[who.id];
        await storage.setItem('googleAccounts', accounts);
        return message.reply(`Okay, I won't invite ${youStr} on Google Calendar anymore.`);
      } else {
        return message.reply(`I wasn't inviting ${youStr} to events on Google Calendar anyway!`);
      }
    } else {
      accounts[who.id] = email;
      await storage.setItem('googleAccounts', accounts);
      return message.reply(`Okay! I'll invite ${youStr} to events on Google Calendar using \`${email}\` from now on.`);
    }
  }

  async rsvpCommand(command, args, message) {
    if (args.slice(-1)[0].startsWith('@'))
      args.pop();
    const eventId = args.shift();
    const response = args.shift();

    const mentioned = message.mentions.users.first();
    const who = mentioned || message.author;
    const youStr = mentioned ? `${mentioned}` : 'you';

    var going;
    var remove;
    var whatStr;
    if (!response || response.toLowerCase() === 'yes') {
      going = true;
      whatStr = "going to";
    } else if (response.toLowerCase() === 'no') {
      going = false;
      whatStr = "not going to";
    } else if (response.toLowerCase() === 'undecided' || response.toLowerCase() === 'invite') {
      going = undefined;
      whatStr = "undecided on";
    } else if (response.toLowerCase() === 'uninvite') {
      remove = true;
      whatStr = "uninvited from";
    } else {
      return message.reply("RSVP with one of: `yes`, `no`, `undecided`, `invite`, or `uninvite`");
    }

    await this.bot.rsvp(eventId, who.id, going, remove);

    const rsvp = await this.bot.getRsvp(eventId);
    const eventTitle = rsvp.title || `${eventId}`;
    return message.reply(`Okay, I've marked ${youStr} as ${whatStr} ${eventTitle}`);
  }

  async listCommand(command, args, message) {
    const all = args.shift();

    const now = moment();
    await this.bot.foreachRsvp(async rsvp => {
      if ((!all || all.toLowerCase() !== 'all') && rsvp.past)
        return;

      var content = new RichEmbed();
      content.setTitle(rsvp.title);
      content.setDescription(rsvp.eventId);
      if (rsvp.color)
        content.setColor(rsvp.color);

      var footer = rsvp.fromNow;
      if (rsvp.hide)
        footer = "Hidden: " + footer;
      content.setFooter(footer, 'https://www.gstatic.com/images/branding/product/2x/calendar_48dp.png');

      await message.channel.send(content);
    });

    return message.reply(`Done`);
  }

}

module.exports = {
  Discord,
};
