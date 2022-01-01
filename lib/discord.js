const { Client, Intents, MessageEmbed, Constants } = require('discord.js');
const moment = require('moment');

class Discord {

  constructor(log, config, calendar) {
    this.log = log;
    this.config = config;
    this.calendar = calendar;

    this.client = new Client({
      intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MEMBERS,
        Intents.FLAGS.GUILD_MESSAGES,
        Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
        Intents.FLAGS.GUILD_SCHEDULED_EVENTS
      ]
    });

    this.yesEmoji = '✅';
    this.noEmoji = '❌';
    this.noResponseEmoji = '😾';
    this.zoomEmoji = '👨‍💻';

    this.client.on('messageCreate', message => {
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
    });

    this.client.on('messageReactionAdd', (reaction, user) => {
      if (user.id === this.client.user.id)
        return;

      this.reactionAdded(reaction, user)
        .catch(err => this.log.error(err, "Error caught during messageReactionAdd"));
    });

    this.client.on('guildScheduledEventUserAdd', (scheduledEvent, user) => {
      if (user.id === this.client.user.id)
        return;

      this.scheduledEventUserAdded(scheduledEvent, user)
        .catch(err => this.log.error(err, "Error caught during guildScheduledEventUserAdd"));
    });

    this.client.on('guildScheduledEventUserRemove', (scheduledEvent, user) => {
      if (user.id === this.client.user.id)
        return;

      this.scheduledEventUserRemoved(scheduledEvent, user)
        .catch(err => this.log.error(err, "Error caught during guildScheduledEventUserRemove"));
    });
  }

  async login() {
    const readyPromise = new Promise((resolve, reject) => {
      this.client.once('error', reject);
      this.client.once('ready', resolve);
    });

    await this.client.login(this.config.discordToken);
    this.log.debug("Login complete");

    await readyPromise;
    this.log.info(`Discord ready`);

    this.guild = this.client.guilds.cache.first();
    await this.guild.fetch();
    this.log.debug("Guild fetched");

    await this.guild.roles.fetch();
    this.log.debug("Guild roles fetched");

    await this.guild.members.fetch();
    this.log.debug("Guild members fetched");
  }

  getRole(name) {
    const role = this.guild.roles.cache.find(r => r.name.toLowerCase() === name);
    if (role) {
      return { members: Array.from(role.members.keys()), color: role.color };
    }
  }

  getChannelNamed(name) {
    return this.guild.channels.cache.find(ch => ch.name.toLowerCase() === name);
  }

  getChannel(rsvp) {
    const channelName = this.bot.state.channels[rsvp.invite] || this.config.channel;
    return this.getChannelNamed(channelName);
  }

  async getNickname(userId) {
    const user = await this.client.users.fetch(userId);
    const member = await this.guild.members.fetch(user);
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

  async updateMessage(rsvp, deleteFirst) {
    const channel = this.getChannel(rsvp);
    // Fetch the existing message and scheduled event.
    let message, scheduledEvent;
    try {
      if (rsvp.messageId)
        message = await channel.messages.fetch(rsvp.messageId);
    } catch (err) {
      this.log.warn(err, `Message missing for rsvp: ${rsvp.messageId}`);
      delete rsvp.messageId;
      message = null;
    }
    try {
      if (rsvp.scheduledEventId)
        scheduledEvent = await this.guild.scheduledEvents.fetch(rsvp.scheduledEventId);
    } catch (err) {
      this.log.warn(err, `Scheduled event missing for rsvp: ${rsvp.scheduledEventId}`);
      delete rsvp.scheduledEventId;
      scheduledEvent = null;
    }

    // Delete an existing message or scheduled event if necessary.
    if (rsvp.hide || rsvp.cancelled || rsvp.significantChange || deleteFirst) {
      if (message) {
        this.log.info(
          { eventId: rsvp.eventId, messageId: rsvp.messageId },
          "Delete message");
        try {
          await message.unpin();
        } catch (err) {
          this.log.warn(err, `Error removing pin for ${rsvp.messageId}`);
        }
        try {
          await message.delete();
        } catch (err) {
          this.log.warn(err, `Error deleting message: ${rsvp.messageId}`);
        }
        delete rsvp.messageId;
        message = null;
      }
      if (scheduledEvent) {
        this.log.info(
          { eventId: rsvp.eventId, scheduledEventId: rsvp.scheduledEventId },
          "Delete scheduled event");
        try {
          await scheduledEvent.delete();
        } catch (err) {
          this.log.warn(err, `Error deleting scheduled event: ${rsvp.scheduledEventId}`);
        }
        delete rsvp.scheduledEventId;
        scheduledEvent = null;
      }
    }

    // Don't send a message if we're hiding it or cancelled.
    if (rsvp.hide || rsvp.cancelled)
      return;

    // Once an event is in the past, unpin the message and forget about it.
    if (rsvp.past) {
      if (message) {
        await message.reactions.removeAll();
        try {
          await message.unpin();
        } catch (err) {
          // Ignore errors.
        }
        delete rsvp.messageId;
        message = null;
      }
      if (scheduledEvent) {
        delete rsvp.scheduledEventId;
        scheduledEvent = null;
      }
      return;
    }

    // Build the message.
    const content = await this.buildMessage(rsvp);
    if (message) {
      this.log.debug(rsvp, "Update message");
      message = await message.edit({ embeds: [content] });
    } else {
      this.log.debug(rsvp, "Announce message");
      message = await channel.send({ embeds: [content] });
    }

    if (message) {
      rsvp.messageId = message.id;

      await message.react(this.yesEmoji);
      await message.react(this.noEmoji);
      await message.react(this.zoomEmoji);
      try {
        await message.pin();
      } catch (err) {
        this.log.warn(err, `Error pinning message ${rsvp.messageId}`);
      }
    }

    // Build the scheduled event.
    const eventInfo = this.buildScheduledEvent(rsvp, channel);
    if (scheduledEvent) {
      this.log.debug(
        { eventId: rsvp.eventId, scheduledEventId: rsvp.scheduledEventId },
        "Update scheduled event");
      scheduledEvent = await scheduledEvent.edit(eventInfo);
    } else {
      const now = moment();
      if (rsvp.start > now) {
        this.log.debug({ eventId: rsvp.eventId }, "Create scheduled event");
        scheduledEvent = await this.guild.scheduledEvents.create(eventInfo);
      }
    }

    if (scheduledEvent)
      rsvp.scheduledEventId = scheduledEvent.id;
  }

  async buildMessage(rsvp) {
    let content = new MessageEmbed();
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

    // Turn the RSVP list into mentions.
    let yes = [], no = [], no_response = [], zoom = [];
    for (let userId of rsvp.invited) {
      const member = await this.guild.members.fetch(userId);

      if (rsvp.zoom.includes(userId)) {
        zoom.push(`${member}`);
      } else if (rsvp.yes.includes(userId)) {
        yes.push(`${member}`);
      } else if (rsvp.no.includes(userId)) {
        no.push(`${member}`);
      } else {
        no_response.push(`${member}`);
      }
    }

    content.addField('Going', `${this.yesEmoji} ${yes.join(' ')}`);
    content.addField('Remote', `${this.zoomEmoji} ${zoom.join(' ')}`);
    content.addField('Not Going', `${this.noEmoji} ${no.join(' ')}`);
    content.addField('No Response', `${this.noResponseEmoji} ${no_response.join(' ')}`);

    content.setFooter({
      text: `${rsvp.fromNow}\n${rsvp.eventId}`,
      iconURL: 'https://www.gstatic.com/images/branding/product/2x/calendar_48dp.png'
    });

    return content;
  }

  buildScheduledEvent(rsvp, channel) {
    const eventInfo = {
      name: rsvp.title,
      scheduledStartTime: rsvp.start,
      scheduledEndTime: rsvp.end,
      privacyLevel: Constants.PrivacyLevels.GUILD_ONLY,
      entityType: Constants.GuildScheduledEventEntityTypes.EXTERNAL,
      description: rsvp.description,
      entityMetadata: {
        location: `${channel}`
      }
    };
    return eventInfo;
  }

  async syncReactions(rsvp) {
    if (!rsvp.messageId)
      return;

    const channel = this.getChannel(rsvp);
    let message;
    try {
      message = await channel.messages.fetch(rsvp.messageId);
    } catch (err) {
      this.log.warn(err, `Message missing for rsvp: ${rsvp.messageId}`);
      return;
    }

    // Process any reactions on the message.
    this.log.info(
      { eventId: rsvp.eventId, messageId: rsvp.messageId },
      "Checking for reactions");
    for (const reaction of message.reactions.cache.values()) {
      await reaction.users.fetch();
      for (const user of reaction.users.cache.values()) {
        if (user.id !== this.client.user.id) {
          this.log.debug(
            { reaction: reaction.emoji.name, user: user.id },
            "Handling extra reaction");
          await this.changeResponseFromReaction(rsvp, reaction, user);
        }
      }
    }
  }

  async reactionAdded(reaction, user) {
    const rsvp = await this.bot.findRsvp(rsvp => rsvp.messageId === reaction.message.id);
    if (!rsvp)
      return;

    await this.changeResponseFromReaction(rsvp, reaction, user);

    try {
      await this.updateMessage(rsvp);
    } finally {
      await this.bot.saveRsvp(rsvp);
    }
  }

  async changeResponseFromReaction(rsvp, reaction, user) {
    if (reaction.emoji.name === this.yesEmoji) {
      this.log.info(`${user} is going to ${rsvp.eventId}`);
      await this.bot.changeResponse(rsvp, user.id, true, false);
    } else if (reaction.emoji.name === this.noEmoji) {
      this.log.info(`${user} is not going to ${rsvp.eventId}`);
      await this.bot.changeResponse(rsvp, user.id, false);
    } else if (reaction.emoji.name === this.noResponseEmoji) {
      this.log.info(`${user} is undecided about ${rsvp.eventId}`);
      await this.bot.changeResponse(rsvp, user.id, undefined);
    } else if (reaction.emoji.name === this.zoomEmoji) {
      this.log.info(`${user} is going to ${rsvp.eventId} via zoom`);
      await this.bot.changeResponse(rsvp, user.id, true, true);
    } else {
      this.log.info(`${user} added unknown reaction ${reaction.emoji}`);
    }

    await reaction.users.remove(user);
  }

  async syncInterested(rsvp) {
    if (!rsvp.scheduledEventId)
      return;

    let scheduledEvent;
    try {
      scheduledEvent = await this.guild.scheduledEvents.fetch(rsvp.scheduledEventId);
    } catch (err) {
      this.log.warn(err, `Scheduled event missing for rsvp: ${rsvp.scheduledEventId}`);
      return;
    }

    this.log.info(
      { eventId: rsvp.eventId, scheduledEventId: rsvp.scheduledEventId },
      "Checking for interested users");
    const subscribers = await scheduledEvent.fetchSubscribers();
    for (const eventUser of subscribers.values()) {
      if (eventUser.user.id !== this.client.user.id) {
        await this.changeResponseFromInterested(rsvp, eventUser.user, true);
      }
    }

    for (const userId of rsvp.interested) {
      if (!subscribers.find(u => u.id === userId)) {
        const user = await this.client.users.fetch(userId);
        await this.changeResponseFromInterested(rsvp, user, false);
      }
    }
  }

  async scheduledEventUserAdded(scheduledEvent, user) {
    const rsvp = await this.bot.findRsvp(rsvp => rsvp.scheduledEventId === scheduledEvent.id);
    if (!rsvp)
      return;

    this.changeResponseFromInterested(rsvp, user, true);

    try {
      await this.updateMessage(rsvp);
    } finally {
      await this.bot.saveRsvp(rsvp);
    }
  }

  async scheduledEventUserRemoved(scheduledEvent, user) {
    const rsvp = await this.bot.findRsvp(rsvp => rsvp.scheduledEventId === scheduledEvent.id);
    if (!rsvp)
      return;

    this.changeResponseFromInterested(rsvp, user, false);

    try {
      await this.updateMessage(rsvp);
    } finally {
      await this.bot.saveRsvp(rsvp);
    }
  }

  async changeResponseFromInterested(rsvp, user, interested) {
    if (interested) {
      if (!rsvp.interested.includes(user.id)) {
        this.log.info(`${user} is interested in ${rsvp.eventId}`);
        rsvp.interested.push(user.id);
        await this.bot.changeResponse(rsvp, user.id, true);
      }
    } else {
      if (rsvp.interested.includes(user.id)) {
        this.log.info(`${user} is no longer interested in ${rsvp.eventId}`);
        rsvp.interested = rsvp.interested.filter(uId => uId !== user.id);
        await this.bot.changeResponse(rsvp, user.id, false);
      }
    }
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

    const rsvp = await this.bot.getRsvp(eventId);
    if (!rsvp)
      return message.reply("Unknown event");

    const mentioned = message.mentions.users.first();
    const who = mentioned || message.author;
    const youStr = mentioned ? `${mentioned}` : 'you';

    let going;
    let zoom;
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
    } else if (response.toLowerCase() === 'zoom') {
      going = true;
      zoom = true;
      whatStr = "remotely participating on";
    } else {
      return message.reply("RSVP with one of: `yes`, `no`, `undecided`, `invite`, or `uninvite`");
    }

    await this.bot.changeResponse(rsvp, who.id, going, zoom, remove);

    try {
      await this.updateMessage(rsvp);
    } finally {
      await this.bot.saveRsvp(rsvp);
    }

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
      const { members, color } = this.getRole(role);
      if (color) {
        rsvp.color = color;
        try {
          await this.updateMessage(rsvp);
        } finally {
          await this.bot.saveRsvp(rsvp);
        }
        return message.reply(`Okay I've updated the color for ${eventTitle}`);
      } else {
        return message.reply("Unknown role");
      }
    } else if (action.toLowerCase() === 'resend') {
      try {
        await this.updateMessage(rsvp, true);
      } finally {
        await this.bot.saveRsvp(rsvp);
      }

      return message.reply(`Okay, I've announced ${eventTitle} again`);
    } else if (action.toLowerCase() === 'delete') {
      rsvp.cancelled = true;
      try {
        await this.updateMessage(rsvp);
      } finally {
        await this.bot.saveRsvp(rsvp);
      }
      return message.reply(`Okay, I've cancelled ${eventTitle}`);
    } else if (action.toLowerCase() === 'invite') {
      this.bot.addInvites(rsvp);
      try {
        await this.updateMessage(rsvp);
      } finally {
        await this.bot.saveRsvp(rsvp);
      }

      return message.reply(`Okay, I'll send invites for ${eventTitle}`);
    } else {
      return message.reply("Specify one of: `color`, `delete`, `resend`, `invite`");
    }
  }

}

module.exports = {
  Discord,
};
