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

      if (command === 'channel') {
        this.channelCommand(command, args, message)
          .catch(err => this.log.error(err, "Error caught during message"));
      }

      if (command === 'rsvp') {
        this.rsvpCommand(command, args, message)
          .catch(err => this.log.error(err, "Error caught during message"));
      }

      if (command === 'edit') {
        this.editCommand(command, args, message)
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
    const role = this.guild.roles.find(r => r.name.toLowerCase() === name);
    if (role)
      return {members: role.members.keys(), color: role.color};
  }

  getChannelNamed(name) {
    return this.guild.channels.find(ch => ch.name.toLowerCase() === name);
  }

  getChannel(rsvp) {
    const channelName = this.bot.state.channels[rsvp.invite] || this.config.channel;
    return this.getChannelNamed(channelName);
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
    if (!rsvp.messageId)
      return;

    this.log.debug(rsvp, "Checking for reactions");

    const channel = this.getChannel(rsvp);
    let message;
    try {
      message = await channel.fetchMessage(rsvp.messageId);
    } catch(err) {
      this.log.warn("Message missing for rsvp: %s", rsvp.messageId);
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

  async resendMessage(rsvp) {
    this.log.debug(rsvp, "Forgetting existing message");
    if (rsvp.messageId) {
      try {
        const channel = this.getChannel(rsvp);
        const message = await channel.fetchMessage(rsvp.messageId);
        if (message) {
          await message.unpin();
          await message.delete();
        }
      } catch(err) {
        this.log.warn("Message missing for rsvp: %s", rsvp.messageId);
      }

      await this.forgetMessage(rsvp);
    }

    await this.updateMessage(rsvp);
  }

  async forgetMessage(rsvp) {
    await storage.removeItem('rsvp-to/' + rsvp.messageId);
    delete rsvp.messageId;
  }

  async updateMessage(rsvp) {
    this.log.debug(rsvp, "Update message");

    // Fetch the existing message.
    const channel = this.getChannel(rsvp);
    let message;
    try {
      if (rsvp.messageId)
        message = await channel.fetchMessage(rsvp.messageId);
    } catch(err) {
      this.log.warn("Message missing for rsvp: %s", rsvp.messageId);
      await this.forgetMessage(rsvp);
      message = null;
    }

    // Delete an existing message if necessary.
    if (message && (rsvp.hide || rsvp.cancelled || rsvp.significantChange)) {
      try {
        await message.unpin();
        await message.delete();
      } catch(err) {
        this.log.warn("Message missing for rsvp: %s", rsvp.messageId);
      }
      message = null;

      await this.forgetMessage(rsvp);
      this.log.debug('Deleted');
    }

    // Don't send a message if we're hiding it or cancelled.
    if (rsvp.hide || rsvp.cancelled) {
      return;
    }

    // Turn the RSVP list into mentions.
    let yes = [], no = [], no_response = [];
    for (let userId of rsvp.invited) {
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
    let content = new RichEmbed();
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

    content.setFooter(`${rsvp.fromNow}\n${rsvp.eventId}`, 'https://www.gstatic.com/images/branding/product/2x/calendar_48dp.png');

    if (message) {
      message = await message.edit(content);
      this.log.debug('Edited');
    } else {
      message = await channel.send(content);
      this.log.debug('Announced');
    }

    rsvp.messageId = message.id;
    await storage.setItem('rsvp-to/' + message.id, rsvp.eventId);

    await message.react(this.yesEmoji);
    await message.react(this.noEmoji);
    await message.pin();
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
    const mentioned = message.mentions.users.first();
    const who = mentioned || message.author;
    const youStr = mentioned ? `${mentioned}` : 'you';
    const youreStr = mentioned ? `${mentioned} isn't` : 'You\'re';

    const currentEmail = this.bot.state.accounts[who.id];

    if (args.slice(-1)[0].startsWith('@'))
      args.pop();
    const email = args.shift().toLowerCase();

    if (!email) {
      if (currentEmail) {
        return message.reply(`I'm inviting ${youStr} to events on \`${currentEmail}\`. Provide a new address or \`off\` to change that.`);
      } else {
        return message.reply(`${youreStr} not getting calendar invites to events. Provide a Google account e-mail address or \`off\``);
      }
    } else if (email === 'off') {
      if (currentEmail) {
        delete this.bot.state.accounts[who.id];
        await this.bot.saveState();
        return message.reply(`Okay, I won't invite ${youStr} on Google Calendar anymore.`);
      } else {
        return message.reply(`I wasn't inviting ${youStr} to events on Google Calendar anyway!`);
      }
    } else {
      this.bot.state.accounts[who.id] = email;
      await this.bot.saveState();
      return message.reply(`Okay! I'll invite ${youStr} to events on Google Calendar using \`${email}\` from now on.`);
    }
  }

  async channelCommand(command, args, message) {
    let role = args.shift().toLowerCase();
    let channel = args.shift().toLowerCase();

    if (!channel) {
      return message.reply("Need a role name and a channel");
    }

    if (role.charAt(0) === '@')
      role = role.substring(1);
    if (!this.getRole(role))
      return message.reply("Unknown role");

    if (channel.charAt(0) === '#')
      channel = channel.substring(1);
    if (!this.getChannelNamed(channel))
      return message.reply("Unknown channel");


    this.bot.state.channels[role] = channel;
    this.bot.saveState();

    return message.reply(`Okay! I'll send invites for @${role} to #${channel} now.`);
  }

  async rsvpCommand(command, args, message) {
    if (args.slice(-1)[0].startsWith('@'))
      args.pop();
    const eventId = args.shift();
    const response = args.shift();

    if (!await this.bot.getRsvp(eventId)) {
      return message.reply("Unknown event");
    }

    const mentioned = message.mentions.users.first();
    const who = mentioned || message.author;
    const youStr = mentioned ? `${mentioned}` : 'you';

    let going;
    let remove;
    let whatStr;
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

  async editCommand(command, args, message) {
    const eventId = args.shift();
    const action = args.shift();

    const rsvp = await this.bot.getRsvp(eventId);
    if (!rsvp)
      return message.reply("Unknown event");
    const eventTitle = rsvp.title || `${eventId}`;

    if (action.toLowerCase() === 'color') {
      const role = args.shift().toLowerCase();
      const {members, color} = this.getRole(role);
      if (color) {
        rsvp.color = color;
        await this.updateMessage(rsvp);
        await this.bot.saveRsvp(rsvp);
        return message.reply(`Okay I've updated the color for ${eventTitle}`);
      } else {
        return message.reply("Unknown role");
      }
    } else if (action.toLowerCase() === 'resend') {
      await this.resendMessage(rsvp);
      await this.bot.saveRsvp(rsvp);

      return message.reply(`Okay, I've announced ${eventTitle} again`);
    } else if (action.toLowerCase() === 'delete') {
      rsvp.cancelled = true;
      await this.bot.saveRsvp(rsvp);
      await this.updateMessage(rsvp);

      return message.reply(`Okay, I've cancelled ${eventTitle}`);
    } else {
      return message.reply("Specify one of: `color`, `delete`, `resend`");
    }
  }

  async listCommand(command, args, message) {
    const all = args.shift();

    const now = moment();
    await this.bot.foreachRsvp(async rsvp => {
      if ((!all || all.toLowerCase() !== 'all') && rsvp.past)
        return;

      let content = new RichEmbed();
      content.setTitle(rsvp.title);
      content.setDescription(rsvp.eventId);
      if (rsvp.color)
        content.setColor(rsvp.color);

      let footer = rsvp.fromNow;
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
