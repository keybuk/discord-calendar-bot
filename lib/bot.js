'use strict';

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
      await this.discord.announceEvent(event)
    }).catch(err => { this.log.error(err, "Error during calendar sync") });
  }

  stop() {
    clearInterval(this.intervalTimeout);
    this.intervalTimeout = undefined;
  }

}

module.exports = {
  Bot
};