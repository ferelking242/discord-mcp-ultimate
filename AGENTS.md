# AGENTS.md

Repository-specific context for agents working in this repo.

## What this is

`discord-mcp-ultimate` — a Discord MCP server. A fork of
[PaSympa/discord-mcp](https://github.com/PaSympa/discord-mcp) 2.2.0 (MIT). The 99
tools from that baseline are preserved unchanged; 73 tools were added, for 172
total. Do not remove baseline tools to simplify anything.

## Commands

```bash
npm ci
npm run build      # tsc -> dist/
npm run lint       # eslint
npm test           # node:test via tsx, 145 tests, no Discord token needed
npm run format     # prettier — run this before committing
```

Run `npm run format` first when a check fails on formatting; the pre-existing
style is prettier's.

## Architecture

- `src/index.ts` — stdio entry point.
- `src/server.ts` — MCP server; dispatches `tools/list` and `tools/call`.
- `src/client.ts` — discord.js client, `ensureConnected()`, guild allow-list,
  shared helpers (`assertBotPermission`, `assertRoleHierarchy`, image fetching).
- `src/safety.ts` — preview/confirm gating, audit trail, duplicate-fingerprint
  suppression, bulk pacing, the typed confirmation phrase constant.
- `src/styleGenerator.ts` — Unicode decoration, naming plans.
- `src/tools/*.ts` — one module per toolset, each exporting a `ToolModule`.
- `src/tools/index.ts` — the `allToolsets` registry keyed by the
  `DISCORD_MCP_TOOLSETS` names, plus `isConnectionFree` and `validateToolArgs`.
- `src/tools/define.ts` — `defineTool` / `defineModule`, and the shared schema
  helpers `guildId`, `snowflake`, `structured`, `confirmation`.

## Conventions

- **Every tool is defined with `defineTool`.** It applies `strictInput`, which
  sets `additionalProperties: false` at every object level. Use `z.strictObject`
  for nested objects; `test/registry.test.ts` walks each schema recursively and
  fails the build if any level omits it.
- **New tools go in a module and must be registered** in `allToolsets` in
  `src/tools/index.ts`, or they are not exposed to a model.
- **Adding a tool changes the count.** `test/server.test.ts` pins the total
  (currently 172) and `test/serverHandshake.test.ts` asserts the handshake lists
  them all. Update the pin deliberately, not reflexively.
- **Mutating tools preview by default** via `resolveGate`. Preview branches return
  before any mutating Discord call.
- **Never default a `confirmation` field.** It is `.literal(...).optional()`, so
  omitting it previews and a wrong value is a schema error.
- **`zod` v4.** `z.object({}).strict()` and `z.strictObject` are equivalent here;
  prefer `z.strictObject`.
- **Describe limitations in the tool description**, not only in the docs. A model
  reads the description before it calls.

## Testing

Tests use mocks and `InMemoryTransport`; no token and no live Discord server.
`test/serverHandshake.test.ts` performs a real MCP handshake, so it catches
schema and registration problems the unit tests cannot.

`test/env-setup.ts` is a setup file, not a test.

Do not run destructive operations against a real server.

## Documentation

The docs must match the code. `docs/TOOL_AUDIT.md` is generated from the compiled
registry — regenerate it rather than editing tables by hand, and never claim a
tool exists that is not in `getAllDefinitions()`.

`docs/SECURITY.md` and `docs/NEW_TOOLS.md` describe guarantees; if you change a
guarantee, change the document in the same commit.

## Publishing

- Remote: `https://github.com/ferelking242/discord-mcp-ultimate`, default branch
  `main`.
- **Push with `$GITHUB_PERSONAL_ACCESS_TOKEN` or `$Pat`.** `$GITHUB_TOKEN` is an
  integration token that authenticates but has no write access to this repo; a
  push with it fails with `403 Permission ... denied`. This cost time once.
- Do not leave a credential in `.git/config`. Set the remote with the token,
  push, then reset the URL to the plain https form.

## Bot and dashboard (this fork's own layers)

`src/bot/` is the long-running bot, `src/dashboard/` the web panel. They are not
MCP tools; do not add them to `src/tools/`.

- **One gateway connection.** The bot, the reaction-role handlers and the MCP
  HTTP transport share the `discord.js` client in `src/client.ts`. Opening a
  second client with the same token gives Discord two sessions and duplicates
  every event.
- **Every store is a `JsonDocument`** (`src/bot/store.ts`). It writes to
  `.tmp` and renames, so a crash mid-write leaves the previous version intact,
  and it detects external changes by **content digest, not mtime** — an mtime
  misses two writes in the same millisecond. Both processes poll, which is what
  lets a dashboard edit reach the bot and the MCP tools without a restart.
- **`BOT_DATA_DIR`** holds every state file. Tests must point it at a temp
  directory; never let a test write into `.data/`.
- **The dashboard shares the MCP port.** `createDashboardHandler` returns `false`
  for a path it does not own so the bearer-authenticated `/mcp` and `/status`
  still route. Adding a catch-all there breaks remote MCP. There is a test for
  this in `test/dashboard.test.ts`.
- **Config schema is Zod v4.** A nested default is `.default(() => schema.parse({}))`,
  not a plain object. `loadConfig` refuses to start on an incoherent combination
  (dashboard without a password, HTTP without a token) — keep those checks.
- **Live verification matters.** Two real bugs (the `/mcp` 404 and the mtime
  comparison) passed every unit test and only showed up when the bot ran against
  Discord. Run `node dist/bot/index.js` with `DASHBOARD_ENABLED=true` before
  claiming a dashboard change works.

## Tool count

`getAllDefinitions()` is authoritative: **177**. The README, `server.json`,
`CHANGELOG.md` and `docs/TOOL_AUDIT.md` state it, and
`test/registry.test.ts` asserts it. Adding a tool fails the build until the docs
are updated — update them rather than relaxing the assertion.

## Test scope

`npm test` runs 284 tests against mocks and in-memory MCP transports. No Discord
token, no live server. Tests that need a real gateway must not be added to the
default `npm test` run.
