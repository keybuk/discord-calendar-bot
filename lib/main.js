const fs = require('mz/fs');
const storage = require('node-persist');
const bunyan = require('bunyan');

const {Calendar} = require('./calendar.js');
const {Discord} = require('./discord.js');

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

  const discord = new Discord(log, config, calendar);
  await discord.login();

  calendar.syncEvents();

  log.debug("Running");
}
