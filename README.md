<div align="center">

# Discord MCP Ultimate

**A Discord MCP server with 174 tools — full server administration, driven by natural language**

[![License](https://img.shields.io/github/license/ferelking242/discord-mcp-ultimate)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](https://nodejs.org)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2)](https://discord.js.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple)](https://modelcontextprotocol.io)

Manage an entire Discord server from **Claude Desktop**, **Claude Code**, **Cursor**, **VS Code Copilot**, or any MCP-compatible client.
Messages, channels, roles, permissions, moderation, server settings, AutoMod, emoji and stickers, and a server architect that builds a structure from a plan.

</div>

---

## What this is

A fork of [PaSympa/discord-mcp](https://github.com/PaSympa/discord-mcp) 2.2.0, MIT licensed.
The 99 tools from that baseline are **preserved unchanged**. This fork adds 75
tools, taking the total to 174, and adds a safety layer that the new tools go
through.

|                                                                     | Baseline 2.2.0      | This fork           |
| ------------------------------------------------------------------- | ------------------- | ------------------- |
| Tools                                                               | 99                  | **174**             |
| Server settings (name, icon, banner, Community, widget, onboarding) | —                   | 24 tools            |
| Bot profile management                                              | —                   | 8 tools             |
| Unicode name styling                                                | —                   | 4 tools             |
| Server architect (plan, compare, apply, repair)                     | —                   | 10 tools            |
| AutoMod                                                             | —                   | 6 tools             |
| Emoji and stickers                                                  | —                   | 8 tools             |
| Structure backup and restore                                        | —                   | 3 tools             |
| Diagnostics and audit trail                                         | —                   | 6 tools             |
| Scheduling and announcements                                        | —                   | 4 tools             |
| Native polls                                                        | —                   | 1 tool              |
| Preview-before-apply gating                                         | partial (`dry_run`) | on every added tool |

Full inventory: [docs/TOOL_AUDIT.md](docs/TOOL_AUDIT.md).
What each new tool does: [docs/NEW_TOOLS.md](docs/NEW_TOOLS.md).

---

## Quick start

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/absolute/path/to/discord-mcp-ultimate/dist/index.js"],
      "env": {
        "DISCORD_TOKEN": "YOUR_BOT_TOKEN_HERE"
      }
    }
  }
}
```

```bash
git clone https://github.com/ferelking242/discord-mcp-ultimate.git
cd discord-mcp-ultimate
npm ci && npm run build
```

No bot yet? [docs/INSTALLATION.md](docs/INSTALLATION.md) covers creating the
application, the intents, the exact permission list, and the invite URL.

Once connected, ask it to run `discord_verify_setup` — it takes no arguments and
tells you whether the token, the intents, the toolsets and the connection are all
in order.

---

## What it can do

### Server administration

Full server-level settings, which the baseline did not cover: rename the server,
change its icon and banner, set the description, splash, verification level,
explicit content filter, notification defaults, locale, AFK channel and timeout,
system/rules/public-updates/safety-alerts channels, the system channel notice
flags, the premium progress bar, Community, the widget, the welcome screen and
onboarding.

Each tool reports what Discord actually returned, and states the limits: a banner
needs boost level 2, a description needs a discoverable or Community server,
Community needs a rules channel and a public-updates channel.

### Bot profile, audited separately

Four things that are easy to conflate, kept apart on purpose:

| Field                                 | Scope       | Settable?                                 |
| ------------------------------------- | ----------- | ----------------------------------------- |
| Server name / icon                    | one server  | yes, Manage Server                        |
| Bot nickname                          | one server  | yes                                       |
| Bot global username / avatar          | all servers | yes                                       |
| Bot banner, global bio, accent colour | global      | **no** — the bot API does not expose them |

`discord_get_bot_profile_limits` returns the changeable and non-changeable lists
with reasons, so "can you change my banner?" gets an answer from a documented
list rather than a guess.

### Unicode name styling

Twelve decoration styles for categories, channels, roles, forums and announcement
channels — minimalist, gaming, cyberpunk, futuristic, luxury, fantasy, anime,
elegant, geometric, bordered, emoji-led and fullwidth.

```
✦・announcements
「📢」・news
╭・community・╮
💬︱general-chat
୨୧・suggestions・୨୧
```

Deterministic (the same input always produces the same output, so re-running a
theme converges), collision-checked, 100-character capped, and stripped of
zero-width characters.

**Stated plainly, in every one of these tool descriptions:** Discord has no
per-server font setting and no API for one. This decorates text with Unicode
characters. It is not a font engine.

### Server architect

Describe the server you want and the architect turns it into an ordered plan,
diffs it against what exists, and creates only what is missing. It is idempotent
and resumable: a run that fails halfway can be repaired by re-running, because
every step has a stable key and failures come back with their index.

Ordering is fixed — roles, then categories, then channels — because channel
permission overwrites reference role IDs that must already exist.

**A bot cannot create a new Discord server.** That needs a user OAuth2 token.
`discord_architect_explain_limits` says so and gives the workflow that does work:
create the server yourself, invite the bot, then apply the plan.

### Safety

Every added mutating tool previews by default. `confirm: true` applies. Bulk
deletion additionally requires the literal string `CONFIRM DELETE`, enforced by
the tool's JSON Schema so a model sees the requirement in `tools/list` before it
calls.

Also included: permission preflight with readable errors, role-hierarchy checks,
`DISCORD_ALLOWED_GUILDS` scoping, duplicate-plan suppression, paced bulk loops,
and an audit trail readable through `discord_read_audit_trail`.

Honest limits are documented rather than glossed: the audit trail is in-process
and capped at 500 entries; a structure backup does not contain messages; deleted
entities are not recoverable.

Details: [docs/SECURITY.md](docs/SECURITY.md).

---

## Configuration

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/absolute/path/to/discord-mcp-ultimate/dist/index.js"],
      "env": {
        "DISCORD_TOKEN": "YOUR_BOT_TOKEN_HERE",
        "DISCORD_GUILD_MEMBERS": "true",
        "DISCORD_MESSAGE_CONTENT": "true"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add discord -- node /absolute/path/to/discord-mcp-ultimate/dist/index.js
```

Set `DISCORD_TOKEN` in the environment Claude Code runs in.

</details>

<details>
<summary><strong>Cursor</strong></summary>

`~/.cursor/mcp.json`, same shape as the Claude Desktop config.

</details>

<details>
<summary><strong>VS Code / GitHub Copilot</strong></summary>

`.vscode/mcp.json`:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "discord-token",
      "description": "Discord Bot Token",
      "password": true
    }
  ],
  "servers": {
    "discord": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/discord-mcp-ultimate/dist/index.js"],
      "env": { "DISCORD_TOKEN": "${input:discord-token}" }
    }
  }
}
```

</details>

<details>
<summary><strong>Docker</strong></summary>

```bash
docker build -t discord-mcp-ultimate .
docker run --rm -i -e DISCORD_TOKEN discord-mcp-ultimate
```

`-e DISCORD_TOKEN` with no value passes it through from your environment, so the
token never lands in a config file.

</details>

---

## Environment variables

| Variable                  | Default      | Purpose                                                                                                                       |
| ------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`           | _(required)_ | Bot token. Never commit it.                                                                                                   |
| `DISCORD_GUILD_MEMBERS`   | `true`       | Request the Server Members intent. Set `false` if the portal toggle is off, or the connection closes with code 4014.          |
| `DISCORD_MESSAGE_CONTENT` | `true`       | Request the Message Content intent. Set `false` for a purely administrative agent — it removes message-body reading entirely. |
| `DISCORD_ALLOWED_GUILDS`  | _(unset)_    | Comma-separated guild IDs. When set, calls outside the list are rejected at parse time.                                       |
| `DISCORD_MCP_TOOLSETS`    | _(unset)_    | Comma-separated toolset names to expose. Unset or `all` exposes everything.                                                   |

See [.env.example](.env.example).

**Toolset names:** `discovery`, `messages`, `channels`, `permissions`, `members`,
`roles`, `moderation`, `screening`, `stats`, `forums`, `webhooks`,
`scheduled_events`, `invites`, `dm`, `guild_settings`, `bot_profile`, `style`,
`architect`, `automod`, `expressions`, `backup`, `diagnostics`, `scheduler`.

Narrowing the toolset is the most effective way to make a model more reliable.
Fewer tools means less to choose between.

---

## Examples

```
Show me every server the bot is in, with member counts.

Rename the server to Watchtower Community.

Update the server icon with this image: https://example.com/icon.png

Read the full settings of server 123456789012345678.

Generate 5 stylized variants for a channel called "announcements".

Apply a futuristic theme to all channel names, but show me the preview first.

Plan a community server for Watchtower with a welcome area, rules, release
announcements, technical support, general discussion, developer roles and two
voice channels. Use a sober futuristic theme.

Compare that plan against the server and create only the missing pieces.

Check which permissions the bot is missing and tell me which tools are affected.

Diagnose why creating a channel in the announcements category fails.

Back up the roles, categories and permissions, then diff it against the server.

Show me a preview before deleting these channels: 111..., 222...
```

Destructive requests return a preview first, with the exact plan and no change
applied. Applying requires a second call with an explicit confirmation.

---

## En français

**Discord MCP Ultimate** est un serveur MCP pour Discord, avec **174 outils**,
pilotable en langage naturel depuis Claude Desktop, Claude Code, Cursor, VS Code
Copilot ou tout client compatible MCP.

C'est un fork de [PaSympa/discord-mcp](https://github.com/PaSympa/discord-mcp)
version 2.2.0 (licence MIT). Les **99 outils d'origine sont conservés à
l'identique**. Ce fork en ajoute **75**, pour un total de 174.

### Ce qui a été ajouté

| Domaine                    | Outils | Ce que ça permet                                                                                                                          |
| -------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Paramètres du serveur      | 24     | Nom, icône, bannière, description, niveau de vérification, filtrage de contenu, salon AFK, Community, widget, écran d'accueil, onboarding |
| Profil du bot              | 8      | Pseudonyme par serveur, avatar global, avatar par serveur, nom global, et l'audit de ce qui n'est **pas** modifiable                      |
| Styles Unicode             | 4      | 12 styles décoratifs pour catégories, salons, rôles et forums, avec aperçu et cohérence de nomenclature                                   |
| Architecte de serveur      | 10     | Plan détaillé, comparaison avec l'existant, création, réparation, modèles, suppression                                                    |
| AutoMod                    | 6      | Règles de modération automatique et jeu de règles de départ                                                                               |
| Emojis et stickers         | 8      | Création, modification, suppression                                                                                                       |
| Sauvegarde et restauration | 3      | Export de la structure, comparaison, restauration additive                                                                                |
| Diagnostic                 | 6      | Vérification de l'installation, permissions manquantes, journal d'audit                                                                   |
| Planification              | 4      | Messages programmés, annonces structurées                                                                                                 |

### Points importants, énoncés franchement

- **Un bot ne peut pas créer un nouveau serveur Discord.** L'API exige un jeton
  OAuth2 d'utilisateur. Créez le serveur vous-même, invitez le bot, puis laissez
  l'architecte construire la structure.
- **Discord n'a aucune police personnalisée.** Le générateur de styles décore du
  texte avec des caractères Unicode. Ce n'est pas un moteur de polices, et les
  outils le disent.
- **La bannière, le splash et l'URL personnalisée** sont réservés aux serveurs de
  niveau 2 de boost.
- **Une sauvegarde ne contient pas les messages.** Discord n'expose pas d'export
  global.
- **Les suppressions sont irréversibles.** Discord n'a pas d'annulation, et le
  serveur ne prétend pas le contraire.

### Sécurité

Tout outil qui modifie quelque chose fait un **aperçu par défaut**. Il faut
rappeler l'outil avec une confirmation explicite pour appliquer. Les suppressions
en masse exigent en plus la chaîne littérale `CONFIRM DELETE`, vérifiée par le
schéma JSON de l'outil — le modèle la voit donc dans `tools/list` avant d'appeler.

S'y ajoutent : la vérification des permissions avant chaque action, le contrôle
de la hiérarchie des rôles, la limitation à certains serveurs via
`DISCORD_ALLOWED_GUILDS`, la protection contre les boucles, et un journal
d'audit.

Détails complets : [docs/SECURITY.md](docs/SECURITY.md).

### Installation

```bash
git clone https://github.com/ferelking242/discord-mcp-ultimate.git
cd discord-mcp-ultimate
npm ci && npm run build
```

Puis, dans la configuration de votre client MCP :

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/chemin/absolu/vers/discord-mcp-ultimate/dist/index.js"],
      "env": { "DISCORD_TOKEN": "VOTRE_JETON_ICI" }
    }
  }
}
```

Les intents, la liste exacte des permissions à cocher et l'URL d'invitation sont
dans [docs/INSTALLATION.md](docs/INSTALLATION.md).

### Exemples de demandes

```
Renomme le serveur en Watchtower Community.

Mets à jour son icône avec cette image : https://exemple.fr/icone.png

Lis tous les paramètres du serveur 123456789012345678.

Génère 5 variantes stylisées pour un salon nommé « annonces ».

Applique un thème futuriste à tous les noms de salons, mais montre-moi l'aperçu
avant.

Prépare un serveur communautaire pour Watchtower avec accueil, règles, annonces
de versions, support technique, discussions, rôles de développeurs et salons
vocaux. Utilise un thème futuriste sobre.

Compare ce plan au serveur et ne crée que ce qui manque.

Vérifie les permissions manquantes du bot et dis-moi quels outils sont touchés.

Montre-moi un aperçu avant de supprimer ces salons : 111..., 222...
```

### Tests

```bash
npm test
```

145 tests, exécutés sans jeton Discord et sans serveur réel, grâce à des mocks et
un transport MCP en mémoire. `test/serverHandshake.test.ts` effectue une vraie
poignée de main MCP et vérifie la liste d'outils annoncée.

---

## Documentation

| Document                                     | Contents                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [docs/TOOL_AUDIT.md](docs/TOOL_AUDIT.md)     | All 174 tools: parameters, permissions checked, hints, output schemas, and the Discord limitations that apply |
| [docs/NEW_TOOLS.md](docs/NEW_TOOLS.md)       | The 73 added tools, module by module, with the design decisions                                               |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Bot creation, intents, the full permission list, every client config, verification                            |
| [docs/SECURITY.md](docs/SECURITY.md)         | Credential handling, preview/confirm gates, permission preflight, prompt-injection boundaries                 |
| [CHANGELOG.md](CHANGELOG.md)                 | Version history                                                                                               |

---

## Limitations

Discord platform limits, stated rather than hidden. Each is also in the
description of the tool it affects.

- **A bot cannot create a new server.** Requires a user OAuth2 token.
- **No custom fonts.** Unicode decoration only; Discord has no font API.
- **Server banner, splash and vanity URL are gated** behind boost level 2 and
  specific server features.
- **No message history in a backup.** No bulk export endpoint exists.
- **Bulk delete cannot remove messages older than 14 days.**
- **Bot banner, global bio and accent colour are not settable** by a bot.
- **The audit trail is in-process**, capped at 500 entries, lost on restart.
- **Deleted entities are gone.** Discord has no undo.
- **Scheduled tasks live in the server process** and do not survive a restart.
  Use an external scheduler for durable timing.

---

## Development

```bash
npm ci
npm run build      # tsc
npm run lint       # eslint
npm test           # node:test, 145 tests
npm run format     # prettier
```

The test suite runs entirely against mocks and in-memory MCP transports — no
Discord token and no live server are needed. `test/serverHandshake.test.ts`
performs a real MCP handshake and asserts the advertised tool list.

---

## Credits and licence

MIT. See [LICENSE](LICENSE).

This is a fork of [PaSympa/discord-mcp](https://github.com/PaSympa/discord-mcp) by
Léandre Moreau. The 99 tools in the imported baseline are that project's work,
preserved unchanged, including their original copyright notice. The 73 added
tools, the safety layer and the documentation are new in this fork.
