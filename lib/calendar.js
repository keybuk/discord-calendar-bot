const fs = require('mz/fs');
const readline = require('readline');
const storage = require('node-persist');
const {google} = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const CREDENTIALS_PATH = 'credentials.json';
const TOKEN_PATH = 'token.json';

class Calendar {

  constructor(log, config) {
    this.log = log;
    this.config = config;

    this.scopes = SCOPES;
    this.credentialsPath = CREDENTIALS_PATH;
    this.tokenPath = TOKEN_PATH;
  }

  async authenticate() {
    const credentials = JSON.parse(await fs.readFile(this.credentialsPath));

    const {client_secret, client_id, redirect_uris} = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    try {
      const tokens = JSON.parse(await fs.readFile(this.tokenPath));
      oAuth2Client.setCredentials(tokens);
    } catch(err) {
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: this.scopes,
      });
      console.log("Authorize this app by visiting this url:", authUrl);

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const code = await new Promise((resolve, reject) => {
        rl.question("Enter the code from that page here: ", (code) => {
          rl.close();
          resolve(code);
        });
      });

      const {tokens} = await oAuth2Client.getToken(code);
      oAuth2Client.setCredentials(tokens);

      await fs.writeFile(this.tokenPath, JSON.stringify(tokens));
    }

    this.calendar = google.calendar({version: 'v3', auth: oAuth2Client});
  }

  async updateEvents(callback) {
    if (!this.syncToken)
      this.syncToken = await storage.getItem('syncToken');

    var pageToken;
    do {
      this.log.debug(`Sync with token ${this.syncToken}`);
      const {data} = await (async () => {
        try {
          return await this.calendar.events.list({
            calendarId: this.config.calendarId,
            singleEvents: true,
            syncToken: this.syncToken,
            pageToken: pageToken
          });
        } catch(err) {
          if (err.code == 410) {
            this.log.warn(err, "Sync Token was declared invalid by server");
            this.syncToken = undefined;
            await storage.removeItem('syncToken');
          } else
            throw err;
        }
      })();
      if (data === undefined) continue;

      if (data.pageToken) {
        pageToken = data.nextPageToken;
        this.log.debug(`${data.items.length} items in sync, next page: ${pageToken}`);
      } else if (data.nextSyncToken) {
        this.syncToken = data.nextSyncToken;
        this.log.debug(`${data.items.length} items in sync, next sync: ${this.syncToken}`);
        await storage.setItem('syncToken', this.syncToken);
      } else {
        this.log.warn(`${data.items.length} items in sync, missing next token`);
      }

      for (var event of data.items) {
        if (event.status === 'cancelled') {
          await storage.removeItem('event/' + event.id);
        } else {
          await storage.setItem('event/' + event.id, event);
        }

        try {
          await callback(event);
        } catch(err) {
          this.log.error(err, "Error caught during event callback");
        }
      }
    } while (pageToken || !this.syncToken);
  }

  async cachedEvent(eventId) {
    return await storage.getItem('event/' + eventId);
  }

  async cachedEvents() {
    return await storage.valuesWithKeyMatch(/^event\//);
  }

  async setAttendees(event, attendees) {
    this.log.debug({attendees: event.attendees}, "Updated attendees");
    await this.calendar.events.patch({
      calendarId: this.config.calendarId,
      eventId: event.id,
      sendUpdates: 'all',
      requestBody: {
        attendees: attendees
      }
    });
  }

}

module.exports = {
  Calendar
};
