const fs = require('mz/fs');
const storage = require('node-persist');
const bunyan = require('bunyan');

const {Calendar} = require('./calendar.js');
const {Bot} = require('./bot.js');

module.exports = async function() {
  const log = bunyan.createLogger({
    name: 'Fluffer',
    streams: [
      {
        level: 'debug',
        stream: process.stdout
      },
      {
        level: 'debug',
        path: 'fluffer.log'
      }
    ]
  });

  await storage.init({
    dir: 'persist'
  });
  const config = JSON.parse(await fs.readFile('config.json'));

  const calendar = new Calendar(log, config);
  await calendar.authenticate();

  const bot = new Bot(log, config, calendar);
  await bot.login();

  await calendar.syncEvents((event) => {
    bot.announceEvent(event)
        .catch(err => log.error(err, "Error during announceEvent"));
  });

  log.debug("Running");
}
