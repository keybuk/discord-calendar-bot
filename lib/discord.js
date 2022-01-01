const { Client, Intents, MessageEmbed } = require('discord.js');
const storage = require('node-persist');
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
        Intents.FLAGS.GUILD_MESSAGE_REACTIONS
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
      if (user.id == this.client.user.id)
        return;

      this.reactionAdded(reaction, user)
        .catch(err => this.log.error(err, "Error caught during messageReactionAdd"));
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

  async syncReactions(rsvp) {
    if (!rsvp.messageId)
      return;

    this.log.debug(rsvp, "Checking for reactions");

    const channel = this.getChannel(rsvp);
    let message;
    try {
      message = await channel.messages.fetch(rsvp.messageId);
    } catch (err) {
      this.log.warn("Message missing for rsvp: %s", rsvp.messageId);
      return;
    }

    // Process any reactions on the message.
    if (message) {
      for (const reaction of message.reactions.cache.values()) {
        for (const user of reaction.users.cache.values()) {
          if (user.id != this.client.user.id) {
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
        const message = await channel.messages.fetch(rsvp.messageId);
        if (message) {
          await message.unpin();
          await message.delete();
        }
      } catch (err) {
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
    // Fetch the existing message.
    const channel = this.getChannel(rsvp);
    let message;
    try {
      if (rsvp.messageId)
        message = await channel.messages.fetch(rsvp.messageId);
    } catch (err) {
      this.log.warn("Message missing for rsvp: %s", rsvp.messageId);
      await this.forgetMessage(rsvp);
      message = null;
    }

    // Delete an existing message if necessary.
    if (message && (rsvp.hide || rsvp.cancelled || rsvp.significantChange)) {
      this.log.info(rsvp, "Delete message");
      try {
        await message.unpin();
        await message.delete();
      } catch (err) {
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

    // Build the message.
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
    content.addField('Going', `${this.yesEmoji} ${yes.join(' ')}`);
    content.addField('Remote', `${this.zoomEmoji} ${zoom.join(' ')}`);
    content.addField('Not Going', `${this.noEmoji} ${no.join(' ')}`);
    content.addField('No Response', `${this.noResponseEmoji} ${no_response.join(' ')}`);

    content.setFooter({
      text: `${rsvp.fromNow}\n${rsvp.eventId}`,
      iconURL: 'https://www.gstatic.com/images/branding/product/2x/calendar_48dp.png'
    });

    if (message) {
      this.log.debug(rsvp, "Update message");
      message = await message.edit({ embeds: [content] });
    } else {
      this.log.debug(rsvp, "Send message");
      message = await channel.send({ embeds: [content] });
    }

    rsvp.messageId = message.id;
    await storage.setItem('rsvp-to/' + message.id, rsvp.eventId);

    await message.react(this.yesEmoji);
    await message.react(this.noEmoji);
    await message.react(this.zoomEmoji);
    await message.pin();
  }

  async reactionAdded(reaction, user) {
    const eventId = await storage.getItem('rsvp-to/' + reaction.message.id);
    if (!eventId)
      return;

    if (reaction.emoji.name === this.yesEmoji) {
      this.log.info(`${user} is going to ${eventId}`);
      await this.bot.rsvp(eventId, user.id, true, false);
    } else if (reaction.emoji.name === this.noEmoji) {
      this.log.info(`${user} is not going to ${eventId}`);
      await this.bot.rsvp(eventId, user.id, false);
    } else if (reaction.emoji.name === this.noResponseEmoji) {
      await this.bot.rsvp(eventId, user.id, undefined);
    } else if (reaction.emoji.name === this.zoomEmoji) {
      this.log.info(`${user} is going to ${eventId} via zoom`);
      await this.bot.rsvp(eventId, user.id, true, true);
    } else {
      this.log.info(`${user} added unknown reaction ${reaction.emoji}`);
    }

    await reaction.users.remove(user);
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

    await this.bot.rsvp(eventId, who.id, going, zoom, remove);

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
      const { members, color } = this.getRole(role);
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
    } else if (action.toLowerCase() === 'invite') {
      await this.bot.refreshInvites(rsvp);
      await this.bot.saveRsvp(rsvp);

      return message.reply(`Okay, I'll send invites for ${eventTitle}`);
    } else {
      return message.reply("Specify one of: `color`, `delete`, `resend`, `invite`");
    }
  }
}

module.exports = {
  Discord,
};
