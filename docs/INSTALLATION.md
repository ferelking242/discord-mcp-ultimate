# Installation

Two ways to run it: from source, or with Docker. Both need a Discord bot token
and a bot invited to your server.

---

## 1. Create the Discord bot

1. Go to <https://discord.com/developers/applications> and click **New
   Application**. Name it whatever you like; this name is the _application_ name,
   which is different from your server's name and from the bot's nickname in a
   server.
2. Open the **Bot** tab and click **Reset Token**, then copy the token. You will
   not be able to see it again.
3. On the same tab, enable the privileged intents you want to use:

   | Intent                     | Required for                                            | Default in this server                     |
   | -------------------------- | ------------------------------------------------------- | ------------------------------------------ |
   | **Server Members Intent**  | member lists, role changes, member search, prune counts | requested (`DISCORD_GUILD_MEMBERS=true`)   |
   | **Message Content Intent** | reading message text, search, embeds, context menus     | requested (`DISCORD_MESSAGE_CONTENT=true`) |
   | **Presence Intent**        | not used                                                | not requested                              |

   If you leave an intent disabled in the portal but requested by the server,
   Discord closes the connection with close code **4014**. Set the matching
   `DISCORD_*` variable to `false` to stop requesting it, or enable it in the
   portal. `discord_verify_setup` reports which intents are currently requested.

4. Open the **OAuth2 → URL Generator** tab. Select the `bot` scope, plus
   `applications.commands` if you also use slash commands. Under **Bot
   Permissions**, tick:

   **General Server Permissions**
   - Manage Server _(server name, icon, banner, widget, welcome screen, Community, AutoMod)_
   - Manage Channels _(create, edit, move, delete channels and categories)_
   - Manage Roles _(roles, role icons, channel permission overwrites)_
   - Manage Webhooks
   - Manage Events
   - Manage Nicknames
   - View Audit Log

   **Membership Permissions**
   - Kick Members
   - Ban Members
   - Moderate Members _(timeouts)_
   - Create Invite

   **Text Channel Permissions**
   - Send Messages
   - Send Messages in Threads
   - Embed Links
   - Attach Files
   - Read Message History
   - Add Reactions
   - Manage Messages _(bulk delete, pin, crosspost)_
   - Create Public Threads
   - Manage Threads
   - Mention Everyone _(only if you want announcement pings; the server never
     parses mentions unless a tool is explicitly asked to)_

   **Voice Channel Permissions**
   - Connect
   - Move Members _(if you use voice moderation)_

   **App Permissions**
   - Use External Emojis
   - Use External Stickers

   **Expression Permissions** _(shown as "Manage Emojis and Stickers" in the
   permission list)_
   - Manage Expressions _(create, edit and delete server emoji and stickers)_

   `discord_get_bot_permissions` returns this same list against your actual
   server, with a `granted` boolean per flag and the tools that need each one.
   Run it after inviting the bot rather than trusting this document.

5. Copy the generated URL and open it in a browser, then pick your server.

**Role hierarchy matters.** A bot cannot edit or delete a role that sits at or
above its own highest role, and cannot act on a member whose highest role is
above its own. After inviting the bot, drag its role above the roles it should
manage in **Server Settings → Roles**. This server checks the hierarchy before
acting and returns an explanation naming the problem rather than letting Discord
return an opaque error.

**Community features** (welcome screen, onboarding, discovery, AutoMod) need
Community enabled on the server. `discord_enable_community` checks for the
required rules and public-updates channels and tells you what is missing.

**A bot cannot create a new Discord server.** `POST /guilds` requires a user
OAuth2 token. Create the server yourself, invite the bot, then use the architect
tools. `discord_architect_explain_limits` returns this with the reason.

---

## 2. Install from source

Requires Node.js 22 or newer.

```bash
git clone https://github.com/ferelking242/discord-mcp-ultimate.git
cd discord-mcp-ultimate
npm ci
npm run build
```

Copy the environment template and fill in your token:

```bash
cp .env.example .env
# then edit .env and set DISCORD_TOKEN
```

Run it:

```bash
npm start
```

It speaks MCP over stdio, so it is meant to be launched by an MCP client, not
used interactively. Running it directly will sit waiting on stdin, which is
correct behaviour.

---

## 3. Install with Docker

```bash
docker build -t discord-mcp-ultimate .
docker run --rm -i \
  -e DISCORD_TOKEN=your_bot_token_here \
  discord-mcp-ultimate
```

Pass any other variables with additional `-e` flags. Use `-i` so stdin stays
open: stdio is the transport.

---

## 4. Connect an MCP client

### Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/absolute/path/to/discord-mcp-ultimate/dist/index.js"],
      "env": {
        "DISCORD_TOKEN": "your_bot_token_here",
        "DISCORD_GUILD_MEMBERS": "true",
        "DISCORD_MESSAGE_CONTENT": "true"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add discord -- node /absolute/path/to/discord-mcp-ultimate/dist/index.js
```

Then set `DISCORD_TOKEN` in the environment Claude Code runs in, or add an
`env` block as above.

### Cursor

`~/.cursor/mcp.json`, same shape as the Claude Desktop config:

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/absolute/path/to/discord-mcp-ultimate/dist/index.js"],
      "env": { "DISCORD_TOKEN": "your_bot_token_here" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json` in your workspace, or the user-level equivalent:

```json
{
  "servers": {
    "discord": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/discord-mcp-ultimate/dist/index.js"],
      "env": { "DISCORD_TOKEN": "your_bot_token_here" }
    }
  }
}
```

### Docker variant

Replace `command` and `args` in any of the above:

```json
{
  "command": "docker",
  "args": ["run", "--rm", "-i", "-e", "DISCORD_TOKEN", "discord-mcp-ultimate"]
}
```

Note the `-e DISCORD_TOKEN` without a value: Docker passes the value through
from the environment, so the token never appears in the config file.

---

## 5. Verify it works

Ask your assistant to run `discord_verify_setup`. It takes no arguments and
returns:

- whether `DISCORD_TOKEN` is set (as a boolean and a length, never the value)
- whether the client reached READY
- the requested gateway intents
- the active toolsets and how many tools they yield
- the guild count and gateway ping
- a `problems` list and a `next_steps` list

This tool works even when the token is missing, which is the point: it is what
you run when nothing else works.

Then run `discord_list_guilds` to confirm the bot can see your server, and
`discord_get_bot_permissions` to confirm it has what it needs.

---

## 6. Environment variables

See [`.env.example`](../.env.example). Summary:

| Variable                  | Default      | Purpose                                                                                                                          |
| ------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`           | _(required)_ | Bot token. Never commit it.                                                                                                      |
| `DISCORD_GUILD_MEMBERS`   | `true`       | Request the Server Members intent. Set `false` if the portal toggle is off.                                                      |
| `DISCORD_MESSAGE_CONTENT` | `true`       | Request the Message Content intent. Same caveat.                                                                                 |
| `DISCORD_ALLOWED_GUILDS`  | _(unset)_    | Comma-separated guild IDs. When set, calls addressed by guild, channel, thread, webhook or invite outside the list are rejected. |
| `DISCORD_MCP_TOOLSETS`    | _(unset)_    | Comma-separated toolset names to expose. Unset or `all` exposes everything. An unknown name aborts startup.                      |

### Toolset names

`discovery`, `messages`, `channels`, `permissions`, `members`, `roles`,
`moderation`, `screening`, `stats`, `forums`, `webhooks`, `scheduled_events`,
`invites`, `dm`, `guild_settings`, `bot_profile`, `style`, `architect`,
`automod`, `expressions`, `backup`, `diagnostics`, `scheduler`.

Narrowing the toolset is the single most effective way to make a model more
reliable: fewer tools means less to choose between. For a server-building task,
`DISCORD_MCP_TOOLSETS=discovery,channels,roles,permissions,style,architect,guild_settings`
exposes the tools that job needs and nothing else.

---

## 7. Example requests

Once connected, these work as plain natural language:

```
Show me every server the bot is in, with member counts.

Read the full settings of server 123456789012345678.

Rename the server to Watchtower Community.

Update the server icon with this image: https://example.com/icon.png

Set the server description to "Self-hosted release monitoring".

Generate 5 stylized variants for a channel called "announcements".

Apply a futuristic theme to all channel names, but show me the preview first.

Plan a community server for Watchtower with a welcome area, rules, release
announcements, technical support, general discussion, developer roles and two
voice channels. Use a sober futuristic theme.

Compare that plan against what the server actually has.

Create only the missing pieces.

Check which permissions the bot is missing and tell me which tools are affected.

Diagnose why creating a channel in the announcements category fails.

Back up the roles, categories and permissions, then show me the diff against
the current server.

Show me a preview before deleting these channels: 111..., 222...
```

Destructive requests return a preview first. The assistant has to call the tool
again with an explicit confirmation before anything is deleted.
