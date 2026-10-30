import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";

import { createServer } from "../src/server.js";
import { createHttpControlPlane } from "../src/bot/http.js";

/**
 * End-to-end test of the HTTP control plane against a real listening socket.
 *
 * No mocks: the server binds an ephemeral port, an MCP client connects over HTTP,
 * and the assertions are made against the bytes that come back. That is the only
 * way to know the transport wiring actually works, since the failure mode of a
 * mis-wired handler is a hang rather than a wrong value.
 */

const TOKEN = "test-http-token";
let server: Server;
let base: string;

before(async () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  server = createHttpControlPlane({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    logger,
    createMcpServer: () => createServer("0.0.0-test"),
    getStatus: () => ({
      discord: { ready: false },
      reactionRoles: { mappings: 0, mode: "toggle" },
    }),
  });
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port assigned");
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("http control plane", () => {
  it("serves /health without a token, so an uptime probe works", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; uptimeSeconds: number };
    assert.equal(body.status, "ok");
    assert.ok(typeof body.uptimeSeconds === "number");
  });

  it("rejects /status and /mcp without a bearer token", async () => {
    for (const path of ["/status", "/mcp"]) {
      const res = await fetch(`${base}${path}`, { method: path === "/mcp" ? "POST" : "GET" });
      assert.equal(res.status, 401, `${path} should require auth`);
    }
  });

  it("rejects a wrong token", async () => {
    const res = await fetch(`${base}/status`, { headers: { authorization: "Bearer nope" } });
    assert.equal(res.status, 401);
  });

  it("reports live status with a valid token", async () => {
    const res = await fetch(`${base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { mcpSessions: number; discord: { ready: boolean } };
    assert.equal(body.discord.ready, false);
    assert.ok(typeof body.mcpSessions === "number");
  });

  it("404s an unknown route rather than hanging", async () => {
    const res = await fetch(`${base}/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 404);
  });

  it("drives the full MCP tool list over HTTP", async () => {
    const client = new Client({ name: "http-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert.equal(tools.length, 177, "the HTTP transport must expose the same tools as stdio");
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("discord_create_reaction_role_menu"));
    assert.ok(names.includes("discord_send_message"));

    await client.close();
  });
});
