# Credits and prior art

This project is a fork of [PaSympa/discord-mcp](https://github.com/PaSympa/discord-mcp)
version 2.2.0, MIT licensed. The original copyright and licence are preserved
verbatim in [LICENSE](../LICENSE), and the 99 tools of that release are kept as
they were.

The bot layer was written for this fork. When designing it we
studied other open-source Discord bots to see how the field solves the same
problems. What follows is what was studied and what was taken from each, so the
debt is visible rather than implied.

## What was studied

| Project                                                         | Licence    | What we looked at                                                                                                           |
| --------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| [discordjs/discord.js](https://github.com/discordjs/discord.js) | Apache-2.0 | The library everything here is built on. No code copied.                                                                    |
| [RTByte/rtbyte](https://github.com/RTByte/rtbyte)               | MIT        | A modular multipurpose bot on Sapphire. Read for the feature set and the module boundaries, not the code.                   |
| [Sapphire Framework](https://github.com/sapphiredev/framework)  | MIT        | Considered as a framework and declined. See below.                                                                          |
| [eritislami/evobot](https://github.com/eritislami/evobot)       | MIT        | A music bot. Read to confirm what this project deliberately does not do.                                                    |
| [Sayrix/Ticket-Bot](https://github.com/Sayrix/Ticket-Bot)       | AGPL-3.0   | **Read only, for the ticket flow.** AGPL was not compatible with shipping code into this MIT project, so nothing was taken. |

## What was taken

Nothing, in the sense of copied code. No source file from any project above was
copied, adapted or transcribed into this repository. The value taken was in
knowing which features matter and how the interfaces should be shaped:

- **Feature selection.** RTByte's module list is the reason tickets, levels,
  giveaways, starboard, temporary voice and an autoresponder are here rather than
  some other set. Which features a mature server bot offers is not obvious until
  you look at a few.
- **Framework decision.** RTByte runs on Sapphire and PostgreSQL. We declined both.
  A self-hosted bot should not need a database and a service to start, so state is
  JSON files written atomically. The trade-off is stated in
  a JSON document: this does not scale to a bot in tens of
  thousands of guilds, and it is not meant to.
- **Web panel decision.** The dashboard projects we read assume an OAuth2 login
  against Discord. We declined that too: it adds a client secret, a redirect URL
  and a token exchange to secure, for a panel with exactly one user. A password and
  a signed cookie is smaller and has less to get wrong.
- **Licence hygiene.** Ticket-Bot was the closest to what we wanted for tickets and
  is AGPL-3.0. We read it for the flow — private channel, claim, transcript before
  delete — and wrote our own implementation. Its code is not in this repository.

## Everything else

The MCP tool layer, the bot subsystem, the storage layer and the
tests in this repository were written for this fork. Where an implementation
follows a known convention, it says so in a comment: the XP curve is MEE6's, and
`docs/BOT_FEATURES.md` says so rather than presenting it as ours.

## Licences

This project is MIT. The full text, with the original copyright notice from
PaSympa/discord-mcp, is in [LICENSE](../LICENSE). Any redistribution must keep that
notice, as MIT requires.

If you are the author of one of the projects above and believe something here
crosses from inspiration into derivation, open an issue and it will be addressed.
