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
      loconsole.g('Authorize this app by visiting this url:', authUrl);

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const code = await new Promise((resolve, reject) => {
        rl.question('Enter the code from that page here: ', (code) => {
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
    if (!this.syncToken) {
      this.syncToken = await storage.getItem('syncToken');
    }

    var pageToken;
    do {
      const {data} = await this.calendar.events.list({
        calendarId: this.config.calendarId,
        singleEvents: true,
        syncToken: this.syncToken,
        pageToken: pageToken
      });

      for (var event of data.items) {
        if (event.status == "cancelled") {
          await storage.removeItem('event/' + event.id);
        } else {
          await storage.setItem('event/' + event.id, event);
        }

        try {
          callback(event);
        } catch(err) {
          this.log.error(err);
        }
      }

      pageToken = data.nextPageToken;
      if (data.nextSyncToken) {
        this.syncToken = data.nextSyncToken;
        await storage.setItem('syncToken', this.syncToken);
      }
    } while (pageToken);
  }

  async syncEvents(callback) {
    if (this.syncTimeout) {
      stopSync();
    }
    await this.updateEvents(callback);
    this.syncTimeout = setInterval(() => {
      this.updateEvents(callback)
        .catch(this.log.error)
    }, this.config.refreshInterval);
  }

  stopSync() {
    clearInterval(this.syncTimeout);
  }

}

module.exports = {
  Calendar
};
