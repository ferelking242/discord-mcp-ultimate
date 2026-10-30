# Dashboard

A web panel for the bot: welcome messages, autoroles, levels, logging, moderation,
tickets, giveaways, starboard, temporary voice channels and the autoresponder. It
runs inside the bot process and is served on the same port as MCP over HTTP.

No framework, no build step, no second service. The page is one HTML document, one
stylesheet and one script, all rendered by the bot itself. That keeps the
deployment a single container and means the dashboard cannot drift from the bot's
own idea of its configuration — it reads and writes the same files.

## Turning it on

```bash
# .env
MCP_HTTP_ENABLED=true
MCP_HTTP_TOKEN=<a long random string>
DASHBOARD_ENABLED=true
DASHBOARD_PASSWORD_HASH=<output of the command below>
DASHBOARD_OPERATOR_ID=<your Discord user id>
```

Generate the password hash:

```bash
node scripts/hash-password.js
```

Then `npm run bot` and open <http://127.0.0.1:3000/>.

The process refuses to start when the dashboard is enabled without a password, or
without the HTTP plane. An unauthenticated dashboard would be remote
administration of the bot, so that combination is treated as a configuration
error rather than a warning.

### Why a hash rather than a plaintext password

`DASHBOARD_PASSWORD` also works and is hashed in memory at startup, so the
comparison is still constant-time. But a plaintext password in `.env` is a
plaintext password in every backup, every `docker inspect`, and every screen
share. `DASHBOARD_PASSWORD_HASH` leaks a scrypt hash instead, which is not
reversible in any practical sense.

## What it can do

| Section            | What you can change                                                  |
| ------------------ | -------------------------------------------------------------------- |
| Vue d'ensemble     | Bot status, guild list, store counts, whether MCP is exposed         |
| Bienvenue          | Join message, channel, welcome DM, goodbye message                   |
| Rôles automatiques | Roles granted on join, minimum account age                           |
| Niveaux            | XP range, cooldown, level-up announcement, role rewards, leaderboard |
| Journaux           | Log channel, which of the 17 event types are logged                  |
| Modération         | Warn, note, timeout, kick, ban, unban, plus the case history         |
| Tickets            | Panel and transcript channels, support roles, one-ticket-per-member  |
| Concours           | Required role, minimum account age, default duration, max winners    |
| Starboard          | Channel, emoji, threshold                                            |
| Vocal temporaire   | Hub channels, category, name template, user limit, empty timeout     |
| Répondeur          | Rules with a trigger, match mode, reply, exempt role, cooldown       |

The moderation panel applies the action through the same code path as the slash
commands, so the permission and role-hierarchy checks are identical. A refused
action reports the reason — "their highest role is at or above the bot's" — rather
than a bare HTTP error.

## Security

The dashboard holds the bot token and the destructive tool surface, so the
defaults are deliberately restrictive.

| Concern                    | How it is handled                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Password storage           | scrypt, salted per password, memory-hard                                                       |
| Session cookie             | HMAC-signed, `HttpOnly`, `SameSite=Strict`, expiry inside the signed payload                   |
| Forged cookie              | Any edit to the payload invalidates the signature                                              |
| Password guessing          | Throttled per client address; a correct guess does not reset the window                        |
| Cross-site request forgery | `SameSite=Strict` plus an `X-CSRF-Token` header on every mutating request                      |
| Script injection           | `Content-Security-Policy: default-src 'none'`, no inline script, no CDN                        |
| Clickjacking               | `X-Frame-Options: DENY` and `frame-ancestors 'none'`                                           |
| Leaked secrets in logs     | Client addresses are hashed; errors are logged without the request body                        |
| Token in the page          | The dashboard never sees the Discord token; it only reads the stores                           |
| Restart                    | Unset `DASHBOARD_SESSION_SECRET` means a new random key each start, so sessions do not survive |

Two honest limitations:

- **The bearer token and the session cookie cross the network in clear over
  `http`.** Locally that is fine. Exposing the port beyond `127.0.0.1` without a
  TLS reverse proxy means anyone on the path can read them. Set
  `DASHBOARD_SECURE_COOKIES=true` once TLS is in place.
- **The dashboard has one account, not a user table.** It is built for a
  self-hosted bot with one operator. Every session has full rights, and there is no
  per-user audit trail beyond the `DASHBOARD_OPERATOR_ID` recorded on moderation
  actions.

## Reverse proxy

The port is bound to `127.0.0.1` by default. To reach it from elsewhere, terminate
TLS in front and keep the token out of logs.

```nginx
server {
  listen 443 ssl;
  server_name bot.example.com;

  ssl_certificate     /etc/letsencrypt/live/bot.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/bot.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # Server-sent events from the MCP transport must not be buffered.
    proxy_buffering off;
    proxy_read_timeout 300s;
  }
}
```

Then set `DASHBOARD_SECURE_COOKIES=true` so the cookie is marked `Secure`.

Do not add a path-based rule that exposes `/api` without `/`, or the login page
will not load and the panel will appear broken.

## API

The panel uses a small JSON API. It is documented here because it is also usable
from a script, and because knowing the shape makes the panel's behaviour easier to
reason about.

Every route except `/health`, `/api/session` and `/api/login` requires the session
cookie. Every `POST`, `PATCH` and `DELETE` also requires `X-CSRF-Token`, whose
value comes from `/api/session`.

| Method   | Path                          | Purpose                                                |
| -------- | ----------------------------- | ------------------------------------------------------ |
| `GET`    | `/health`                     | Liveness. No auth, no secrets.                         |
| `GET`    | `/api/session`                | Whether the caller is logged in, plus the CSRF token   |
| `POST`   | `/api/login`                  | `{ password }` → session cookie                        |
| `POST`   | `/api/logout`                 | Clears the cookie                                      |
| `GET`    | `/api/overview`               | Bot info, guild list, store counts                     |
| `GET`    | `/api/guilds/:id`             | Channels, roles, member count, bot's role position     |
| `GET`    | `/api/guilds/:id/config`      | The full config, defaults applied                      |
| `PATCH`  | `/api/guilds/:id/config`      | Merge one or more sections                             |
| `PUT`    | `/api/guilds/:id/config`      | Replace the whole config                               |
| `DELETE` | `/api/guilds/:id/config`      | Reset to defaults                                      |
| `GET`    | `/api/guilds/:id/members`     | Member list, `?limit=` capped at 500                   |
| `GET`    | `/api/guilds/:id/leaderboard` | Top members by XP                                      |
| `GET`    | `/api/guilds/:id/tickets`     | Ticket history                                         |
| `GET`    | `/api/guilds/:id/giveaways`   | Giveaway history                                       |
| `POST`   | `/api/guilds/:id/moderation`  | `{ action, userId, reason, durationMs? }`              |
| `GET`    | `/api/cases`                  | Moderation history, newest first, `?guildId=` optional |

`PATCH` merges and `PUT` replaces, which is not a detail: the panel edits one
section at a time, and a replace would wipe every section the request did not
mention. Arrays are replaced rather than merged, so removing a role from a list is
possible.

Example:

```bash
# Log in and keep the cookie.
curl -sS -c jar.txt -X POST http://127.0.0.1:3000/api/login \
  -H 'content-type: application/json' -d '{"password":"..."}'

# Read the CSRF token.
CSRF=$(curl -sS -b jar.txt http://127.0.0.1:3000/api/session | jq -r .csrf)

# Enable levels and set the XP range.
curl -sS -b jar.txt -X PATCH http://127.0.0.1:3000/api/guilds/$GUILD/config \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"levels":{"enabled":true,"xpMin":20,"xpMax":30}}'
```

## Storage

The dashboard writes the same JSON files the MCP tools and the bot use, under
`BOT_DATA_DIR` (default `.data`):

| File                           | Contents                 |
| ------------------------------ | ------------------------ |
| `guild-config.json`            | Every setting, per guild |
| `reaction-roles.json`          | Reaction-role menus      |
| `moderation-cases.json`        | Case history             |
| `levels.json`                  | XP and levels            |
| `tickets.json`                 | Tickets                  |
| `giveaways.json`               | Giveaways and entrants   |
| `starboard.json`               | Mirrored messages        |
| `temp-voice.json`              | Temporary channels       |
| `autoresponder-cooldowns.json` | Reply cooldowns          |

Writes go to a temp file and are renamed over the target, so a crash mid-write
leaves the previous version intact. Both processes poll for changes, so a change
made in the panel reaches the MCP tools and the running bot without a restart.

Back up that one directory and you have backed up the bot's entire state. Note
what is _not_ in it: message content, member profiles, anything Discord already
stores. There is nothing to keep in sync and nothing that drifts.

## Troubleshooting

**The login page reloads instead of logging in.** `DASHBOARD_SECURE_COOKIES=true`
over plain `http`. The browser refuses to return a `Secure` cookie, so the session
never sticks. Turn it off, or put TLS in front.

**Saving says "missing or invalid CSRF token".** The page was open across a bot
restart, which invalidated the session when `DASHBOARD_SESSION_SECRET` was unset.
Reload the page. Set the secret to keep sessions across restarts.

**The page loads but is unstyled.** A reverse proxy is not forwarding
`/dashboard.css`, or the CSP is being stripped and the browser is blocking the
script. Check that `Content-Security-Policy` reaches the browser unchanged.

**"DASHBOARD_OPERATOR_ID is not set"** when applying moderation. Set it to your
Discord user id. Every moderation action needs an attributable actor, and the
dashboard has no other way to know who you are.

**A moderation action fails with "their highest role is at or above the bot's".**
Discord's role hierarchy, not a bug. Move the bot's role above the target's in
Server Settings → Roles.
