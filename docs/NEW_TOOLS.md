# New tools — what was added, and why

This document covers the 78 tools added on top of the 99 imported from
PaSympa/discord-mcp 2.2.0. For the full inventory, including the preserved
tools, see [TOOL_AUDIT.md](./TOOL_AUDIT.md).

Every tool named here is registered in `src/tools/index.ts` and therefore
visible to an MCP client through `tools/list`. Counts in this document are
generated from the build, not written by hand.

---

## 1. Safety infrastructure — `src/safety.ts`

Not a tool module itself. This is the shared layer every new mutating tool goes
through, and it is where most of the reliability work lives.

| Primitive                              | What it does                                                                                                                                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveGate({ confirm, dry_run })`    | Returns whether a call is a preview or an apply. A bare call previews; only an explicit `confirm: true` applies. An explicit `dry_run: true` always wins, even alongside `confirm: true`.                                                                  |
| `recordAction(...)`                    | Appends to an in-process audit trail, capped at 500 entries.                                                                                                                                                                                               |
| `readAuditTrail(limit)`                | Reads it back, newest first.                                                                                                                                                                                                                               |
| `isDuplicateFingerprint(fp, windowMs)` | Returns true for a repeat of the same plan inside the window, so a model looping on one plan cannot create the same channel twice.                                                                                                                         |
| `throttleBulk()`                       | Shared 250 ms pacing between calls in a bulk loop.                                                                                                                                                                                                         |
| `runPaced(items, worker)`              | Runs a bulk loop one item at a time, collecting per-item failures instead of aborting. This is what makes a build resumable.                                                                                                                               |
| `confirmationPhrase("delete")`         | The single source of truth for the typed phrase. Tool schemas consume it via `.literal(confirmationPhrase("delete"))`, so the requirement is enforced by the JSON Schema and advertised to the model in `tools/list` rather than checked inside a handler. |

`confirmationPhrase` is used by exactly one tool today,
`discord_architect_delete_structure`. It exists as a named constant rather than a
string literal in the schema so that the phrase and the message describing it can
never drift apart.

**Why a typed phrase and not `confirm: true`.** A defaulted boolean can be
supplied by a model that never considered the consequence. A literal string
(`"CONFIRM DELETE"`) has to appear in the model's output, which means it has to
have been decided on. `confirmation` is deliberately **not** `.default(false)`
for the same reason.

**Why it is a schema constraint and not a runtime assertion.** Enforcing it with
`.literal()` means the phrase appears in the tool's advertised `inputSchema`, so
a model reading `tools/list` sees the requirement before calling, a wrong phrase
is rejected before the server tries to reach Discord, and there is exactly one
mechanism to audit. `test/serverHandshake.test.ts` asserts that near-misses
(`"DELETE"`, `"confirm delete"`, `"CONFIRM"`, a trailing space) are all rejected
and that the field carries no default.

Covered by `test/safety.test.ts` (10 tests).

---

## 2. Unicode style generator — `src/styleGenerator.ts` + `src/tools/style.ts`

**4 tools.**

| Tool                       | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `discord_list_name_styles` | The 12 available styles with descriptions.                               |
| `discord_style_name`       | One name, one variant per requested style (or all 12).                   |
| `discord_style_preview`    | A coherent naming plan for a whole server, with collisions and warnings. |
| `discord_apply_name_theme` | Renames existing categories, channels and roles. Previews by default.    |

Styles: `minimal`, `gaming`, `cyberpunk`, `futuristic`, `luxury`, `fantasy`,
`anime`, `elegant`, `geometric`, `bordered`, `emoji_lead`, `fullwidth`.

### Non-Latin names, emoji and safety

Three defects found while restyling a real 15-language server, all fixed and
covered by regression tests:

1. **`slugify` erased every non-Latin script.** The filter was `[^a-z0-9]`, so
   `русский`, `العربية`, `日本語`, `हिन्दी`, `ไทย` and `中文` all slugified to
   `""` and fell back to the same generic name. Six distinct language channels
   would have been renamed to six identical ones. The filter is now `\p{L}\p{N}`
   (plus `\p{M}`, since some scripts carry combining marks inside a word).
2. **Cyrillic `й` lost its breve.** A blanket combining-mark strip decomposed
   `й` into `и`, turning `русский` into `русскии`. Diacritics are now stripped
   from Latin letters only, and the string is recomposed with NFC afterwards.
3. **Composed emoji were split apart.** `🧑‍💻` became `🧑`, because the
   invisible-character strip removes U+200D, which is what holds a ZWJ sequence
   together. The emoji is now read from the raw name before that strip runs.

`discord_apply_name_theme` carries each entity's **existing emoji** into the new
name (`keepEmoji`), so `🇷🇺・русский` becomes `🇷🇺︱русский` and keeps the flag that
identifies the language. It also:

- uses the entity's own name as the fallback, so an undecoratable name keeps its
  identity instead of collapsing onto the word "channel";
- **refuses to apply** when two entities would end up sharing a name, listing
  them so they can be added to `keep_plain`. Discord permits duplicate names,
  but they become indistinguishable in the sidebar;
- accepts `announcement_channels` in `include`, so announcement channels are
  themed alongside the rest.

Example output: `✦・announcements`, `「📢」・news` is produced by the bordered and
emoji_lead combination, `╭・community・╮`, `💬︱general-chat`, `୨୧・suggestions・୨୧`.

Guarantees, each pinned by a test:

- **Invisible characters are stripped.** Zero-width space, zero-width joiner,
  word joiner, BOM and soft hyphen are removed before anything else happens.
- **No empty names.** Input that slugifies to nothing falls back to `channel`,
  and the result reports `fallback: true`.
- **The 100-character cap is respected by every style**, by trimming the slug and
  never the decoration, so a truncated name keeps its frame.
- **Deterministic.** The same slug always produces the same emoji and decoration,
  so re-running a theme converges instead of stacking.
- **Distinct.** No two styles produce the same output for the same input.

**Honest limitation, repeated in every tool description:** Discord has no
per-server font setting. This decorates text with Unicode characters. It is not a
font engine and the module does not pretend to be one.

Covered by `test/styleGenerator.test.ts` (12 tests) and parts of
`test/new-modules.test.ts`.

---

## 3. Server architect — `src/tools/serverArchitect.ts`

**10 tools.** Turns a declarative plan into Discord structure, and reports what
it cannot do rather than guessing.

| Tool                                 | Purpose                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `discord_architect_plan`             | Validate a plan and expand it into ordered, keyed steps. No Discord call. |
| `discord_architect_read_structure`   | Read the current guild structure.                                         |
| `discord_architect_compare`          | Diff a desired plan against the current server.                           |
| `discord_architect_apply`            | Create the missing entities. Idempotent, resumable, previews by default.  |
| `discord_architect_repair`           | Re-run only the steps that failed.                                        |
| `discord_architect_explain_limits`   | The API limitations, with reasons.                                        |
| `discord_architect_create_template`  | Snapshot the structure as a reusable guild template.                      |
| `discord_architect_list_templates`   | List templates.                                                           |
| `discord_architect_delete_template`  | Delete a template.                                                        |
| `discord_architect_delete_structure` | Delete channels and roles. Requires `"CONFIRM DELETE"`.                   |

Key properties:

- **Ordering is fixed and tested.** Roles first, then categories, then channels,
  because channel permission overwrites reference role IDs that must already
  exist. `planToSteps` is exported and unit-tested directly.
- **Stable keys.** Every step gets a deterministic key (`role:dev`,
  `channel:Cat/one`) so a resumed run can be diffed by key rather than by name.
- **Per-item failure isolation.** One bad channel does not strand the rest; the
  failures come back with their index for the repair pass.
- **Duplicate suppression.** Re-submitting an identical plan inside the window is
  refused instead of building everything twice.
- **Preview before write.** The preview branch returns before any _mutating_
  Discord call, so a preview cannot create or delete anything. The plan-only
  tools (`discord_architect_plan`, `discord_architect_explain_limits`) touch no
  Discord state at all and work with no token configured.

**The limitation that matters most:** a bot cannot create a brand-new Discord
server. `POST /guilds` needs a _user_ OAuth2 bearer token. `discord_architect_explain_limits`
returns this with the reason and the workflow to use instead (create the server
by hand, invite the bot, then apply). No tool here fakes it.

Covered by `test/serverArchitect.test.ts` (13 tests).

---

## 4. Guild settings — `src/tools/guildSettings.ts`

**25 tools.** The server-level settings surface.

Identity: `discord_get_guild_settings`, `discord_set_guild_name`,
`discord_set_guild_icon`, `discord_remove_guild_icon`,
`discord_set_guild_banner`, `discord_remove_guild_banner`,
`discord_set_guild_description`, `discord_set_guild_splash`.

Safety and structure: `discord_set_guild_safety` (verification level, explicit
content filter, default notifications, NSFW level), `discord_set_guild_channels`
(AFK channel and timeout, system, rules, public-updates and safety-alerts
channels), `discord_set_system_channel_notices`, `discord_set_guild_locale`,
`discord_set_premium_progress_bar`, `discord_enable_community`.

Discovery and diagnostics: `discord_get_guild_features`,
`discord_get_guild_preview`, `discord_get_guild_vanity_url`,
`discord_get_bot_permissions`.

Widget: `discord_set_guild_widget`, `discord_get_guild_widget`.

Onboarding: `discord_get_welcome_screen`, `discord_set_welcome_screen`,
`discord_get_onboarding`, `discord_set_onboarding`.

Membership gate: `discord_set_membership_gate`. It can switch the screening gate
_off_, but not on: Discord returns HTTP 200 to a `PATCH /guilds/{id}` that adds
`MEMBER_VERIFICATION_GATE_ENABLED` and then drops the feature. The tool reports
the real post-call `features`, so a refusal is visible as `enabled: false`. See
[MULTILINGUAL.md](./MULTILINGUAL.md#rules-acceptance-what-actually-works).

`discord_get_bot_permissions` is worth calling out: it lists every permission
flag this server's tools need, whether the bot currently has it, and which tools
need it. That is how a model answers "why did that fail?" with a fact.

`discord_enable_community` checks for the rules and public-updates channels
_before_ calling Discord, because the API rejects a first enable without them
with an opaque 400.

Covered by parts of `test/new-modules.test.ts`.

---

## 5. Bot profile — `src/tools/botProfile.ts`

**8 tools.** Kept separate from guild settings on purpose, because these are four
different things that are easy to conflate.

| Tool                                  | Changes                                                       |
| ------------------------------------- | ------------------------------------------------------------- |
| `discord_get_bot_identity`            | Reads the current state, and spells out the distinctions.     |
| `discord_set_bot_nickname`            | The bot's nickname **in one server**.                         |
| `discord_set_bot_avatar`              | The bot's **global** avatar.                                  |
| `discord_set_bot_username`            | The bot's **global** username. Rate-limited by Discord.       |
| `discord_set_bot_guild_avatar`        | A **per-server** avatar override.                             |
| `discord_set_application_icon`        | The bot application's icon.                                   |
| `discord_set_application_description` | The application's description.                                |
| `discord_get_bot_profile_limits`      | Read-only. Exactly what is and is not settable, with reasons. |

`discord_get_bot_profile_limits` exists so that "can you change the bot's
banner?" is answered from a documented list rather than from guesswork. It
returns `changeable` (field, scope, tool) and `not_changeable` (field, reason).
The banner, the global bio and the accent colour are in the second list, because
the bot API does not expose them.

Covered by parts of `test/new-modules.test.ts`.

---

## 6. AutoMod — `src/tools/automod.ts`

**6 tools.** `discord_list_automod_rules`, `discord_get_automod_rule`,
`discord_create_automod_rule`, `discord_edit_automod_rule`,
`discord_delete_automod_rule`, `discord_apply_automod_baseline`.

`discord_apply_automod_baseline` creates a sensible starter set (mention spam,
link spam, profanity, keyword block) in one call, previewing by default.

AutoMod uses the `ManageGuild` permission, not a separate `ManageAutoMod` flag:
Discord's permission bitfield has no such flag, and claiming otherwise would send
a user looking for a toggle that does not exist.

---

## 7. Emoji and stickers — `src/tools/expressions.ts`

**8 tools.** `discord_list_emojis`, `discord_create_emoji`,
`discord_edit_emoji`, `discord_delete_emoji`, `discord_list_stickers`,
`discord_create_sticker`, `discord_edit_sticker`, `discord_delete_sticker`.

`discord_create_emoji` enforces Discord's 256 KB cap on emoji images before
calling the API, so an oversized upload fails with a size message rather than an
opaque 400. The shared 10 MB image limit from `src/client.ts` still applies
first.

---

## 8. Backup and restore — `src/tools/backup.ts`

**3 tools.** `discord_export_structure`, `discord_restore_structure`,
`discord_compare_structure`.

The backup format is versioned (`discord-mcp-ultimate/structure-backup@1`) and
covers roles, categories, channels and their permission overwrites.

**What a backup is not:** it does not contain messages. Discord has no bulk
export endpoint, and scraping every channel would be slow, rate-limited and would
miss deleted messages anyway. `discord_export_structure` returns
`message_history_included: false` and says so in its description.

Restoring into a guild that already has entities creates duplicates by design;
`discord_compare_structure` is there to preview that before it happens.

---

## 9. Diagnostics — `src/tools/diagnostics.ts`

**6 tools.** `discord_explain_permissions`, `discord_check_tool_permissions`,
`discord_find_permission_problems`, `discord_diagnose_configuration`,
`discord_read_audit_trail`, `discord_verify_setup`.

`discord_verify_setup` reports whether the token is set (as a boolean and a
length, never the value), which intents are requested, which toolsets are
exposed, how many tools that yields, whether the client reached READY, and the
ping. It is in the connection-free set, so it works in exactly the situation it
exists for: a broken install.

`discord_check_tool_permissions` takes a list of tool names and reports, per
tool, whether the bot has what that tool needs, with the missing flags named. An
unknown tool name is reported as `known_tool: false` and `ready: false` — never
as ready.

`discord_read_audit_trail` is explicitly labelled as _this server's_ trail, not
Discord's audit log. Discord's own audit log is read by the preserved
`discord_get_audit_log` tool, which is unchanged from the 2.2.0 baseline.

---

## 10. Scheduling — `src/tools/scheduler.ts`

**4 tools.** `discord_schedule_message`, `discord_list_scheduled_tasks`,
`discord_cancel_scheduled_task`, `discord_publish_announcement`.

Scheduled tasks live in the MCP server process. They are **lost when the process
restarts**, and the tool says so in its response rather than leaving the caller
to discover it. For durable scheduling, use an external scheduler and call the
MCP server from it.

`discord_publish_announcement` posts a structured announcement to an
announcement channel and crossposts it. It parses **no** mentions by default
(`allowed_mentions: { parse: [] }`), so a body containing `@everyone` cannot ping
the server by accident. A deliberate ping requires an explicit `ping` argument,
and `ping: "role"` additionally requires `ping_role_id`.

---

## 11. Native polls — `discord_send_poll` in `src/tools/messages.ts`

**1 tool.** `discord_send_poll`.

Discord has polls in its own API, so a third-party poll bot is redundant. The tool
sends a native poll: Discord renders the vote UI, tallies the votes and closes it
on schedule.

| Field               | Constraint                      |
| ------------------- | ------------------------------- |
| `question`          | max 300 characters              |
| `answers`           | 2 to 10, max 55 characters each |
| `duration_hours`    | 1 to 768, defaults to 24        |
| `allow_multiselect` | false by default                |

The constraints are enforced in the Zod schema, so an out-of-range call fails
locally with a clear message instead of a Discord `50035` form error.

```jsonc
// "Which language should we add next?"
{
  "channel_id": "...",
  "question": "Which language should we add next?",
  "answers": ["한국어", "Nederlands", "Polski"],
  "duration_hours": 168,
  "allow_multiselect": false,
}
```

---

## 12. Reaction-role menus — `src/tools/reactionRoles.ts`

**3 tools.** `discord_create_reaction_role_menu`, `discord_list_reaction_role_menus`,
`discord_delete_reaction_role_menu`.

These are the MCP half of a feature whose other half is the bot in `src/bot/`. The
tools post the menu, add each reaction, and record the emoji→role mapping; the bot
process owns the gateway and grants the roles. The two processes meet at one JSON
file that the bot watches, so a menu an agent builds takes effect within two
seconds and needs no restart.

Why the split: a stdio MCP server only runs while its host is driving it. There is
nothing to receive a reaction event between tool calls, so a reaction-role feature
cannot live in the tool process alone. `npm run bot` is the process that stays awake.

`discord_create_reaction_role_menu` validates every role before posting: a role
managed by an integration, or one at or above the bot's highest role, is reported in
`warnings` and skipped. Discord would refuse the grant later anyway, and the failure
would land on an ordinary member rather than on the agent that built the menu.

Covered by `test/bot.test.ts`.

---

## The 24/7 bot — `src/bot/`

Not a toolset, but the reason the reaction-role tools can work at all.

| File               | Responsibility                                                          |
| ------------------ | ----------------------------------------------------------------------- |
| `config.ts`        | Strict env parsing; refuses to start an unauthenticated HTTP port       |
| `handlers.ts`      | Reaction, role and welcome logic, with no client or env dependency      |
| `reactionRoles.ts` | Atomic JSON store with a watcher, so the MCP side reaches the bot       |
| `rateLimit.ts`     | Per-member sliding window, so one member cannot rate-limit everyone     |
| `http.ts`          | `/health`, `/status`, `/mcp` with a constant-time bearer check          |
| `index.ts`         | Wires the above to the shared discord.js client and the signal handlers |

The bot and the MCP server share **one** discord.js client. A second client with the
same token would open a second gateway session and double every event. Reaction
intents are therefore opt-in through `DISCORD_REACTION_INTENTS`, which the bot sets
and a stdio user does not need.

Covered by `test/bot.test.ts` (unit) and `test/http.test.ts` (a real socket, a real
MCP client over HTTP).

---

## Environment variables added

None. Every new tool uses `DISCORD_TOKEN`, `DISCORD_ALLOWED_GUILDS`,
`DISCORD_MCP_TOOLSETS` and the existing intent toggles. See `.env.example`.

## Toolset names for `DISCORD_MCP_TOOLSETS`

The new modules are selectable by name, alongside the preserved ones:
`guildSettings`, `botProfile`, `style`, `serverArchitect`, `automod`,
`expressions`, `backup`, `diagnostics`, `scheduler`, `reaction_roles`.

Setting `DISCORD_MCP_TOOLSETS=style,serverArchitect` exposes 14 tools and nothing
else — useful for keeping a model's context small and its options narrow. The
toolset name is the key in `src/tools/index.ts`, not the file name: it is
`reaction_roles` (underscore), because the env var is a comma-separated list and a
name that cannot be confused with a separator is worth the small inconsistency.
