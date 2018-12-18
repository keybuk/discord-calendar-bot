const fs = require('mz/fs');
const storage = require('node-persist');
const bunyan = require('bunyan');

const {Calendar} = require('./calendar.js');
const {Bot} = require('./bot.js');

async function main() {
  const log = bunyan.createLogger({
    name: 'Fluffer',
    stream: process.stdout,
    level: 'debug'
  });

  await storage.init();
  const config = JSON.parse(await fs.readFile('config.json'));

  const calendar = new Calendar(log, config);
  await calendar.authenticate();

  const bot = new Bot(log, config, calendar);
  await bot.login();

  await calendar.syncEvents((event) => {
    bot.announceEvent(event)
      .catch(console.log);

    if (event.start) {
      const start = event.start.dateTime || event.start.date;
      console.log(`${start} - ${event.summary}`);
    }
  });
}

main()
  .catch(console.log);
