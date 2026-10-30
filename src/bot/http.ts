import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { Logger } from "./handlers.js";

export interface HttpControlPlaneOptions {
  host: string;
  port: number;
  /** Bearer token required on every route except `/health`. */
  token: string;
  logger: Logger;
  /** Builds a fresh MCP server. A new one per session keeps sessions isolated. */
  createMcpServer: () => {
    connect: (transport: StreamableHTTPServerTransport) => Promise<void>;
  };
  /** Live status, surfaced by `GET /status`. */
  getStatus: () => Record<string, unknown>;
  /** Extra keys merged into `GET /health`, for a richer uptime check. */
  extraHealth?: () => Record<string, unknown>;
}

/** Constant-time string compare that tolerates length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limitBytes = 4 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

/**
 * HTTP control plane.
 *
 * Two things share the port: the MCP Streamable HTTP transport at `/mcp`, so a
 * remote client can drive the same 174 tools the stdio server exposes, and a small
 * status surface for an operator or uptime check. Everything but `/health`
 * requires the bearer token — this process holds a bot token and the full
 * destructive tool surface, so an unauthenticated port would be a remote admin
 * endpoint.
 */
export function createHttpControlPlane(opts: HttpControlPlaneOptions): Server {
  const startedAt = Date.now();
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      // Uptime probes must not need a secret, and must not leak anything either.
      if (path === "/health" && req.method === "GET") {
        return json(res, 200, {
          status: "ok",
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          ...(opts.extraHealth?.() ?? {}),
        });
      }


      const header = req.headers.authorization ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!presented || !safeEqual(presented, opts.token)) {
        return json(res, 401, { error: "unauthorized" });
      }

      if (path === "/status" && req.method === "GET") {
        return json(res, 200, {
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          mcpSessions: sessions.size,
          ...opts.getStatus(),
        });
      }

      if (path === "/mcp") {
        return await handleMcp(req, res, sessions, opts);
      }

      return json(res, 404, {
        error: "not found",
        routes: ["/health", "/status", "/mcp"],
      });
    } catch (err) {
      opts.logger.error("http request failed", { error: (err as Error).message });
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    }
  });

  server.listen(opts.port, opts.host, () => {
    opts.logger.info("http control plane listening", {
      url: `http://${opts.host}:${opts.port}`,
      routes: ["/health", "/status", "/mcp"],
    });
  });

  return server;
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, StreamableHTTPServerTransport>,
  opts: HttpControlPlaneOptions,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // A known session id reuses its transport; anything else opens a new session.
  let transport = sessionId ? sessions.get(sessionId) : undefined;
  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport!);
        opts.logger.info("mcp session opened", { sessionId: id, open: sessions.size });
      },
    });
    transport.onclose = () => {
      if (transport?.sessionId) {
        sessions.delete(transport.sessionId);
        opts.logger.info("mcp session closed", {
          sessionId: transport.sessionId,
          open: sessions.size,
        });
      }
    };
    const mcp = opts.createMcpServer();
    await mcp.connect(transport);
  }

  const body = req.method === "POST" ? await readBody(req) : undefined;
  await transport.handleRequest(req, res, body);
}
