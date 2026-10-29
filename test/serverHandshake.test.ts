import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { getAllDefinitions, hasTool, isConnectionFree } from "../src/tools/index.js";

/** Boots a real server over an in-memory transport, as an MCP client would. */
async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer("test");
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("tools/list serves every definition and rejects unexpected cursors", async () => {
  const { client, server } = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, getAllDefinitions().length);
  for (const tool of tools) {
    assert.ok(
      tool.description && tool.description.length > 20,
      `${tool.name} needs a real description`,
    );
    assert.equal(tool.inputSchema.type, "object", `${tool.name} input root must be an object`);
  }
  await assert.rejects(() => client.listTools({ cursor: "next-page" } as never), /not paginated/);
  await client.close();
  await server.close();
});

test("every registered tool has a handler and a unique name", () => {
  const names = getAllDefinitions().map((d) => d.name);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
  for (const name of names) assert.ok(hasTool(name), `${name} has no handler`);
});

test("the diagnostic and pure tools run without a Discord connection", async () => {
  const { client, server } = await connect();
  // These tools exist to explain a broken setup, so a missing token must not be
  // what stops them. This is the exact scenario a user hits on first install.
  const calls: [string, Record<string, unknown>][] = [
    ["discord_verify_setup", {}],
    ["discord_get_bot_profile_limits", {}],
    ["discord_architect_explain_limits", {}],
    ["discord_list_name_styles", {}],
    ["discord_style_name", { name: "annonces" }],
    [
      "discord_style_preview",
      { theme: "minimal", items: [{ kind: "text_channel", name: "chat" }] },
    ],
    [
      "discord_architect_plan",
      {
        plan: {
          roles: [],
          categories: [{ name: "Cat", channels: [{ name: "one", kind: "text" }] }],
        },
      },
    ],
  ];
  for (const [name, args] of calls) {
    assert.ok(isConnectionFree(name), `${name} should be in the connection-free set`);
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(
      result.isError,
      true,
      `${name} failed without a token: ${JSON.stringify(result.content)}`,
    );
    assert.doesNotThrow(
      () => JSON.parse(result.content[0]!.text as string),
      `${name} must return JSON`,
    );
  }
  await client.close();
  await server.close();
});

test("verify_setup never leaks the token value into its output", async () => {
  const { client, server } = await connect();
  const result = await client.callTool({ name: "discord_verify_setup", arguments: {} });
  const text = result.content[0]!.text as string;
  const token = process.env.DISCORD_TOKEN;
  if (token) assert.ok(!text.includes(token), "the token value must never be echoed");
  const data = JSON.parse(text) as { token_configured: boolean; token_length: number };
  assert.equal(typeof data.token_configured, "boolean");
  assert.equal(typeof data.token_length, "number", "report the length, never the value");
  await client.close();
  await server.close();
});

test("a tool needing Discord reports the missing token instead of hanging", async () => {
  const { client, server } = await connect();
  const saved = process.env.DISCORD_TOKEN;
  delete process.env.DISCORD_TOKEN;
  const result = await client.callTool({
    name: "discord_get_guild_settings",
    arguments: { guild_id: "111111111111111111" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text as string, /DISCORD_TOKEN is required/);
  process.env.DISCORD_TOKEN = saved;
  await client.close();
  await server.close();
});

test("invalid arguments are rejected by the schema before any handler runs", async () => {
  const { client, server } = await connect();
  const cases: [string, Record<string, unknown>, RegExp][] = [
    [
      "discord_style_preview",
      { theme: "not-a-theme", items: [{ kind: "text_channel", name: "x" }] },
      /theme/,
    ],
    ["discord_style_preview", { theme: "minimal", items: [] }, /items|at least|empty/i],
    ["discord_style_name", { name: "x", bogus: 1 }, /bogus|unrecognized/i],
    ["discord_get_guild_settings", { guild_id: "not-a-snowflake" }, /snowflake/i],
    ["discord_get_guild_settings", {}, /guild_id/],
  ];
  for (const [name, args, pattern] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} should reject ${JSON.stringify(args)}`);
    assert.match(result.content[0]!.text as string, pattern);
  }
  await client.close();
  await server.close();
});

test("an unknown tool name is an InvalidParams error, not a silent success", async () => {
  const { client, server } = await connect();
  await assert.rejects(
    () => client.callTool({ name: "discord_definitely_not_a_tool", arguments: {} }),
    /Unknown tool/,
  );
  await client.close();
  await server.close();
});
