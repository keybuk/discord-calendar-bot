const fs = require('mz/fs');
const storage = require('node-persist');

const {Calendar} = require('./calendar.js');
const {Bot} = require('./bot.js');

const CALENDAR_ID = 'netsplit.com_dil3ieljjf7jsp3qvaqk0ggda0@group.calendar.google.com';

async function main() {
  await storage.init();
  const config = JSON.parse(await fs.readFile('config.json'));

  const calendar = new Calendar(config.calendarId);
  await calendar.authenticate();

  const bot = new Bot(config.discordToken, config.discordChannel);
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
