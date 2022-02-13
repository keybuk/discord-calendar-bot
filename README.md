This has been written to serve a single Discord guild, paired to a single Google
Calendar shared by all channels in that guild.

Note that this is not a "hands free" or "simple" setup, and requires working
knowledge of running Discord bots and Google APIs. If these are outside your
experience, other projects may be better suited.

# Configuration

The bot needs a `config.json` and `token.json` file in the working directory.
It'll create `persist`, `persist-events`, and `persist-rsvp` directories to
store its state.

## Example `config.json`
```
{
    "calendarId": "...",
    "discordClientId": "...",
    "discordSecret": "...",
    "discordToken": "...",
    "channel": "...",
    "refreshInterval": 60000,
    "limit": 7,
    "prefix": "!"
}
```

## Example `token.json`
```
{
    "access_token": "...",
    "refresh_token": "..."
    "scope": "https://www.googleapis.com/auth/calendar.events"
    "token_type": "Bearer",
    "expiry_date": ...
}
```
# Discord Bot Setup

You'll need to setup a Discord Bot instance, and fill in the `discordClientId`,
`discordSecret`, and `discordToken` fields in the `config.json`.

# Google Calendar Setup

You'll need to setup a Google Calendar and authenticate the bot for API access,
filling in the `token.json` with the results and the `calendarId` in
`config.json`

# Other setup

Put the name of the general Discord channel (without `#`) in `channel`. You can
adjust the `prefix` for bot commands, and the `refreshInterval` for sync with
Google (leave it at `60000`, really).

The `limit` field is the number of days before an event that the bot will
add invites if not already present, and even if the event is not the next one
for a given role.

# Games (Roles and Channels)

The bot assumes that the calendar is used to schedule a number of concurrent
games, and that each game has an associated Discord Role and Channel with
a 1:1 map between each of them.

To associate a Role with a channel, use:
```
!channel @Game #game
```

To specify which game a calendar event is associated with, include the role
name in the description as:
```
Invite: Game
```

# Players

The bot will track invites through the reactions to the Discord message, or
interested marks on the Discord scheduled event. In Google they will appear as
`discord@Username`.

This can be changed to the user's Google Calendar address, and real invites
sent via the calendar.

To associate a Player's Discord user with their Google Calendar address, use:
```
!google @User user@gmail.com
```

# Calendar Events

In addition to `Invite:` the bot will also recognize `Image:` as a URL to an
image to include in the invite. Other text is added to the description of the
event.

```
Invite: Game
Image: http://some/cool/image.jpg

Description of the game
```
