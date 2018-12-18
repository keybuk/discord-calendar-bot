const Discord = require('discord.js');
const storage = require('node-persist');

class Bot {

  constructor(token, channelName) {
    this.token = token;
    this.channelName = channelName;

    this.client = new Discord.Client();
    this.client.on('ready', () => { this.ready() });
  }

  async login() {
    await this.client.login(this.token);
    console.log('Login complete');
  }

  ready() {
    console.log("I am ready!");
    this.channel = this.client.channels.find(ch => ch.name === this.channelName);
  }

  async announceEvent(event) {
    const messageId = await storage.getItem('announce/' + event.id);
    if (messageId) {
      const message = await this.channel.fetchMessage(messageId);

      if (event.status == 'cancelled') {
        await message.delete();
        await storage.removeItem('announce/' + event.id);
        console.log('Deleted');
      } else {
        const {content} = this.eventMessage(event);
        await message.edit(content);
        console.log('Edited');
      }
    } else if (event.status != 'cancelled') {
      const {content} = this.eventMessage(event);
      const message = await this.channel.send(content);
      await storage.setItem('announce/' + event.id, message.id);
      console.log('Announced');
    }
  }

  eventMessage(event) {
    const start = event.start.dateTime || event.start.date;

    var content = {
      'embed': {
        'title': event.summary,
        'description': event.description,
        'image': {
          'url': "https://geekandsundry.com/wp-content/uploads/2016/04/ToDKeyArt3.jpg"
        },
        'fields': [
          {
            'name': "When",
            'value': `${start}`
          },
          {
            'name': "Going",
            'value': ":white_check_mark: @keybuk, @laposheureux"
          },
          {
            'name': "Not Going",
            'value': ":x: @steve"
          },
          {
            'name': "No Response",
            'value': ":pouting_cat: \@henry"
          }
        ]
      }
    };

    return {content: content};
  }

}

module.exports = {
  Bot,
};
