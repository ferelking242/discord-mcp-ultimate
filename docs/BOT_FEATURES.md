# Bot features

Everything the bot does on its own, without an AI in the loop: welcome messages,
autoroles, levels, logging, moderation, tickets, giveaways, starboard, temporary
voice channels and the autoresponder. All of it is configured from the
`/config`, and all of it is off until you turn it
on.

A bot that starts welcoming, logging and levelling the moment it joins a server is
a bot people kick. Every feature below has an explicit `enabled` flag and a
sensible default.

## Turning a feature on

From Discord:

```
/config set fonction:Niveaux actif:true
/config channel fonction:Journaux salon:#logs
/config show
```

`/config show` sends the whole configuration as a JSON file, because it is longer
than an embed holds.

## Command reference

| Command                            | Permission       | What it does                          |
| ---------------------------------- | ---------------- | ------------------------------------- |
| `/ping`                            | everyone         | Round-trip and gateway latency        |
| `/rank [membre]`                   | everyone         | Level, XP and rank                    |
| `/leaderboard`                     | everyone         | Top ten by XP                         |
| `/warn membre raison`              | Moderate Members | Warns, DMs the member, records a case |
| `/cases membre`                    | Moderate Members | That member's case history            |
| `/giveaway lot [duree] [gagnants]` | Manage Events    | Starts a giveaway with a Join button  |
| `/ticket-panel`                    | Manage Channels  | Posts the open-a-ticket panel here    |
| `/config show \| set \| channel`   | Manage Server    | Reads and writes settings             |
| `/permissions`                     | everyone         | Which permissions the bot is missing  |

Commands are registered globally by default, which Discord can take up to an hour
to show. Set `DISCORD_DEV_GUILD` to a guild id during setup and they appear
immediately there.

## Welcome and goodbye

Posted in a channel, optionally also as a DM.

```
{user}         → mentions the member
{username}     → their username, no mention
{server}       → the server name
{memberCount}  → the member count
```

An unknown placeholder is left as written rather than blanked: `{usernam}` is a
typo you can see, an empty string looks like the bot is broken.

The join message mentions the new member and nothing else, so it cannot become a
mass ping.

## Autoroles

Roles granted on join, with an optional minimum account age.

Two reasons a role is not granted, and both are logged with the reason:

- The role is **managed** by an integration. Discord refuses to let a bot grant it.
- The role sits **at or above the bot's highest role**. Move the bot's role up.

The age gate exists because a fresh account is the cheapest way to raid a server,
and the join window is when the damage happens. The command only offers roles the
bot can actually grant, so a misconfiguration is visible before it matters.

## Levels

XP per message with a per-member cooldown, the MEE6 curve, role rewards and a
leaderboard.

| Setting        | Default | Note                              |
| -------------- | ------- | --------------------------------- |
| XP per message | 15–25   | Random, inclusive                 |
| Cooldown       | 60s     | Per member, not per channel       |
| Announce       | on      | In the channel, or a chosen one   |
| Role rewards   | none    | Granted when the level is reached |

The cooldown is per member rather than per channel on purpose: otherwise posting
one word in five channels at once multiplies the gain. Channels and roles can be
excluded from earning XP entirely.

XP writes are debounced. A busy server would otherwise mean a disk write per
message; instead the store batches and flushes, and shutdown flushes what is
pending.

## Logging

Seventeen event types, one channel. Where Discord's audit log can name who did it,
the embed says so — "a message was deleted" is far less useful than "X deleted
Y's message".

```
messageDelete  messageEdit     memberJoin      memberLeave
memberBan      memberUnban    memberUpdate    roleCreate
roleDelete     roleUpdate     channelCreate   channelDelete
channelUpdate  voiceJoin      voiceLeave      inviteCreate
inviteDelete
```

Attribution needs **View Audit Log**. Without it the event is still logged, just
without the moderator's name.

Two details that avoid noise: an edit is only logged when the content actually
changed, and a delete of a message the bot never cached says so rather than
claiming the content was empty.

## Moderation

`/warn` and the MCP moderation tools both go through the same code path, so
the checks are identical. Every action is recorded as a numbered case.

| Action    | Notes                                                      |
| --------- | ---------------------------------------------------------- |
| warn      | DMs the member; the case is the record                     |
| note      | Internal, no DM, no effect on the member                   |
| timeout   | Default 10 minutes, capped at Discord's 28 days            |
| untimeout | Refused if they are not currently timed out                |
| kick      | Needs Kick Members and a higher role                       |
| ban       | Works on a user id, so it does not need the member present |
| unban     | Refused if they are not banned                             |

Refusals explain themselves:

- _"their highest role is at or above the bot's. Move the bot's role higher."_
- _"the server owner cannot be banned by the bot"_ — Discord exempts the owner.
- _"the bot lacks Ban Members"_

A case is written **only after** Discord confirms the action. A case file claiming
a ban that never happened is worse than no case file, because it is what a
moderator later relies on.

## Tickets

One private channel per request, with a claim button and a close button that posts
a transcript before deleting.

- Permissions are set per ticket: the requester and the support roles see it, and
  `@everyone` does not.
- A support role at or above the bot's role is skipped with a warning, rather than
  silently producing a channel the team cannot read.
- One open ticket per member by default, and a cap on total open tickets, so a
  single member cannot create channels until the server hits its limit.
- Closing fetches up to 100 messages, posts them as a `.txt` in the transcript
  channel, and only then deletes the channel. Discord cannot undo a channel
  deletion, so the transcript has to exist first.
- A ticket opened before a restart is still tracked after it, because the store is
  on disk.

## Giveaways

A Join button, an optional required role, an optional minimum account age, and a
draw that happens automatically at the deadline.

The draw is a poll every 20 seconds rather than a timer per giveaway. Timers do not
survive a restart, and a giveaway that ended while the bot was down would otherwise
never be drawn. Entrants are stored, so the draw is correct after a restart too.

Winners are picked without replacement. A giveaway with no entrants is closed with
"no winner" rather than staying open forever.

## Starboard

Mirrors a message into a channel once it passes a reaction threshold.

The count is read from the source message rather than incremented locally: a member
can un-react, and a counter that only goes up would never notice. The bot's own
reaction is excluded, so it does not push a message over the threshold by itself.

The stored entry is edited when the count changes instead of a second copy being
posted.

## Temporary voice channels

Joining a hub channel creates a personal channel, moves you into it, and deletes it
after it has been empty for a while.

The grace period is what makes the feature usable: people hop out to grab a link
and come back, and a channel that vanishes instantly is a bug report. A channel
created before a restart is still cleaned up after it.

## Autoresponder

Rules with a trigger, a match mode, a reply, an exempt role and a cooldown.

| Match mode   | Behaviour                                          |
| ------------ | -------------------------------------------------- |
| `contains`   | Anywhere in the message, case-insensitive          |
| `exact`      | The whole message, ignoring surrounding whitespace |
| `startsWith` | From the beginning                                 |

Replies never parse mentions. A rule whose text contains `@everyone` renders it
literally rather than pinging the server — that is the difference between a welcome
message and an incident.

Cooldowns are per member and per rule, so one member cannot make the bot repeat
itself until it is muted. That is the usual reason autoresponders get removed from
servers.

## Reaction roles

Covered in the main README. The short version: the AI creates the menu through an
MCP tool, the bot serves it, and a new menu reaches the running bot within two
seconds without a restart.

## Reaction intents

The bot needs the **Message Content** and **Guild Members** privileged intents,
which must be enabled in the Developer Portal. Without them Discord closes the
gateway with code 4014, and the bot logs exactly that plus what to do about it.

If you do not need message reading — an administration-only bot, for instance —
turn `DISCORD_MESSAGE_CONTENT` off. It also closes off the main prompt-injection
surface, since the bot stops reading message bodies at all.

## What is deliberately not here

Stated plainly rather than left to be discovered:

- **No music playback.** Streaming audio from a bot is a licensing question, not a
  feature question, and the popular libraries for it are unmaintained.
- **No economy or currency.** XP exists to unlock roles; a second currency would be
  another store and another set of exploits for little gain.
- **No raid protection beyond the account-age gate.** Real raid handling needs a
  scoring model over join velocity and account signals, which is its own project.
  AutoMod rules and Discord's own verification levels cover the common cases.
- **No reaction to accept the rules.** It is possible with the bot awake, but a
  half-built version that can be bypassed is worse than none.
- **No web panel.** Everything is configured from Discord with `/config`, so
  there is no second service to deploy, secure and keep in sync.
