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
