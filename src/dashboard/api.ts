import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "../bot/handlers.js";
import type { BotServices } from "../bot/services.js";
import { guildConfigSchema, type GuildConfig } from "../bot/guildConfig.js";
import { Authenticator, clientKey, type Session } from "./auth.js";

/**
 * The dashboard's JSON API.
 *
 * Written against `node:http` rather than a framework: the surface is a dozen
 * routes, and a framework would add a dependency, a middleware order to reason
 * about, and a second way of doing what the bot already does. The router below is
 * small enough to read in one sitting, which matters more here than brevity.
 *
 * Two rules the routes follow:
 *
 * - **Every mutating route checks CSRF.** `SameSite=Strict` covers the common
 *   cross-site form post; the token covers the rest.
 * - **Discord is reached through {@link DashboardBackend}**, never directly. That
 *   keeps the routes testable without a gateway connection, and keeps the
 *   discord.js calls in one file where the permission checks live.
 */

// ─── Backend contract ──────────────────────────────────────────────────────────

export interface GuildSummary {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number;
  ownerId: string;
  botPresent: boolean;
}

export interface GuildDetail extends GuildSummary {
  channels: { id: string; name: string; type: string; parentId: string | null }[];
  roles: { id: string; name: string; position: number; managed: boolean; color: number }[];
  botHighestRolePosition: number;
}

export interface MemberSummary {
  id: string;
  tag: string;
  displayName: string;
  joinedAt: string | null;
  isBot: boolean;
  roleIds: string[];
}

export interface ModerationRequest {
  action: "warn" | "timeout" | "untimeout" | "kick" | "ban" | "unban" | "note";
  guildId: string;
  userId: string;
  reason: string;
  durationMs?: number;
  moderatorId: string;
}

/**
 * What the dashboard needs from the bot. Implemented in `src/bot/backend.ts`.
 *
 * `moderatorId` on a moderation request is the dashboard operator's Discord id,
 * which the operator configures — the dashboard cannot know it otherwise, and
 * every moderation action needs an attributable actor.
 */
export interface DashboardBackend {
  listGuilds(): Promise<GuildSummary[]>;
  getGuild(guildId: string): Promise<GuildDetail | null>;
  listMembers(guildId: string, limit: number): Promise<MemberSummary[]>;
  applyModeration(request: ModerationRequest): Promise<{ caseNumber: number; summary: string }>;
  services: BotServices;
  botInfo(): { tag: string; id: string; uptimeSeconds: number; ping: number };
}

export interface DashboardApiOptions {
  backend: DashboardBackend;
  auth: Authenticator;
  logger: Logger;
  /** The Discord id recorded as the actor for actions taken from the dashboard. */
  operatorId?: string;
  /** Rendered dashboard page, served at `/`. */
  renderPage: () => string;
  /** Stylesheet, served at `/dashboard.css`. */
  renderCss: () => string;
  /** Client script, served at `/dashboard.js`. */
  renderScript: () => string;
  /** Whether the MCP HTTP transport shares this port. */
  mcpEnabled: boolean;
}

// ─── Small HTTP helpers ────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // The API returns live state; a cached copy would show stale config.
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    // No inline script, no external origin, no framing. The page is one document
    // with a same-origin script file, so nothing else needs to be allowed.
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.discordapp.com; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  res.end(html);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, "request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "request body is not valid JSON");
  }
}

/** Splits `/api/guilds/123/config` into `["api","guilds","123","config"]`. */
function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

// ─── The router ────────────────────────────────────────────────────────────────

export interface DashboardHandler {
  (req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

/**
 * Builds the request handler. Returns true when the request was handled here, so
 * the caller can fall through to the MCP transport on the same port.
 */
export function createDashboardHandler(opts: DashboardApiOptions): DashboardHandler {
  const { backend, auth, logger } = opts;

  const requireSession = (req: IncomingMessage): Session => {
    const token = Authenticator.readCookie(req.headers.cookie, auth.sessionCookieName);
    const session = auth.verifySession(token);
    if (!session) throw new HttpError(401, "not authenticated");
    return session;
  };

  const requireCsrf = (req: IncomingMessage, session: Session): void => {
    const header = req.headers["x-csrf-token"];
    if (!auth.verifyCsrf(session, Array.isArray(header) ? header[0] : header)) {
      throw new HttpError(403, "missing or invalid CSRF token");
    }
  };

  /** Reads a guild's settings, creating the defaults on first touch. */
  const configFor = async (guildId: string): Promise<GuildConfig> => {
    const detail = await backend.getGuild(guildId);
    if (!detail) throw new HttpError(404, `the bot is not in guild ${guildId}`);
    return backend.services.guildConfig.get(guildId);
  };

  return async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const parts = segments(path);
    const method = req.method ?? "GET";

    try {
      // ─── Public ──────────────────────────────────────────────────────────────
      if (path === "/health" && method === "GET") {
        sendJson(res, 200, {
          status: "ok",
          bot: backend.botInfo().tag,
          uptimeSeconds: backend.botInfo().uptimeSeconds,
        });
        return true;
      }

      if (path === "/api/session" && method === "GET") {
        const token = Authenticator.readCookie(req.headers.cookie, auth.sessionCookieName);
        const session = auth.verifySession(token);
        sendJson(res, 200, {
          authenticated: session !== null,
          csrf: session?.csrf ?? null,
          expiresAt: session?.expiresAt ?? null,
          usesHashedPassword: auth.usesHashedPassword,
        });
        return true;
      }

      if (path === "/api/login" && method === "POST") {
        const body = await readJson(req);
        const password = typeof body.password === "string" ? body.password : "";
        const key = clientKey(req.socket.remoteAddress);
        const result = auth.checkPassword(password, key);
        if (!result.ok) {
          logger.warn("dashboard login failed", { client: key });
          if (result.retryAfterMs) {
            res.setHeader("retry-after", String(Math.ceil(result.retryAfterMs / 1000)));
            throw new HttpError(429, "too many attempts, try again later");
          }
          throw new HttpError(401, "invalid password");
        }
        const session = auth.createSession();
        logger.info("dashboard login", { client: key });
        res.setHeader("set-cookie", auth.sessionCookie(session));
        sendJson(res, 200, {
          authenticated: true,
          csrf: session.csrf,
          expiresAt: session.expiresAt,
        });
        return true;
      }

      if (path === "/api/logout" && method === "POST") {
        res.setHeader("set-cookie", auth.clearCookie());
        sendJson(res, 200, { authenticated: false });
        return true;
      }

      if (path === "/dashboard.css" && method === "GET") {
        const css = opts.renderCss();
        res.writeHead(200, {
          "content-type": "text/css; charset=utf-8",
          "content-length": Buffer.byteLength(css),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(css);
        return true;
      }

      if (path === "/dashboard.js" && method === "GET") {
        const script = opts.renderScript();
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "content-length": Buffer.byteLength(script),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(script);
        return true;
      }

      // Anything outside these prefixes belongs to another handler on this port —
      // `/mcp` and `/status`, which authenticate with the bearer token. Returning
      // false lets the caller route them instead of answering 404 here.
      const owned =
        path === "/" ||
        path === "/index.html" ||
        path === "/health" ||
        path === "/api" ||
        path.startsWith("/api/");
      if (!owned) return false;

      // ─── Authenticated ───────────────────────────────────────────────────────
      if (parts[0] !== "api") {
        if (path === "/" || path === "/index.html") {
          sendHtml(res, opts.renderPage());
          return true;
        }
        throw new HttpError(404, "not found");
      }

      const session = requireSession(req);

      if (path === "/api/overview" && method === "GET") {
        const guilds = await backend.listGuilds();
        sendJson(res, 200, {
          bot: backend.botInfo(),
          guilds,
          stats: backend.services.stats(),
          mcpEnabled: opts.mcpEnabled,
        });
        return true;
      }

      if (path === "/api/cases" && method === "GET") {
        const guildId = url.searchParams.get("guildId") ?? undefined;
        const cases = backend.services.moderation
          .all()
          .filter((c) => !guildId || c.guildId === guildId)
          .slice(-100)
          .reverse();
        sendJson(res, 200, { cases });
        return true;
      }

      if (parts[1] !== "guilds") throw new HttpError(404, "not found");
      const guildId = parts[2];
      if (!guildId) throw new HttpError(400, "guild id is required");
      const rest = parts.slice(3).join("/");

      if (rest === "" && method === "GET") {
        const detail = await backend.getGuild(guildId);
        if (!detail) throw new HttpError(404, `the bot is not in guild ${guildId}`);
        sendJson(res, 200, detail);
        return true;
      }

      if (rest === "config" && method === "GET") {
        sendJson(res, 200, { config: await configFor(guildId) });
        return true;
      }

      if (rest === "config" && (method === "PATCH" || method === "PUT")) {
        requireCsrf(req, session);
        const body = await readJson(req);
        // A PATCH merges one section; a PUT replaces the whole document. The
        // distinction matters because the dashboard edits a section at a time and a
        // replace would wipe the sections the request did not mention.
        const config =
          method === "PUT"
            ? await backend.services.guildConfig.set(guildId, guildConfigSchema.parse(body))
            : await backend.services.guildConfig.patch(guildId, body as never);
        logger.info("dashboard config updated", { guildId, method });
        sendJson(res, 200, { config });
        return true;
      }

      if (rest === "config" && method === "DELETE") {
        requireCsrf(req, session);
        await backend.services.guildConfig.reset(guildId);
        logger.info("dashboard config reset", { guildId });
        sendJson(res, 200, { config: backend.services.guildConfig.get(guildId) });
        return true;
      }

      if (rest === "members" && method === "GET") {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
        sendJson(res, 200, { members: await backend.listMembers(guildId, limit) });
        return true;
      }

      if (rest === "leaderboard" && method === "GET") {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 10) || 10, 100);
        sendJson(res, 200, { leaderboard: backend.services.levels.leaderboard(guildId, limit) });
        return true;
      }

      if (rest === "tickets" && method === "GET") {
        sendJson(res, 200, {
          tickets: backend.services.tickets
            .where((t) => t.guildId === guildId)
            .slice(-100)
            .reverse(),
        });
        return true;
      }

      if (rest === "giveaways" && method === "GET") {
        sendJson(res, 200, {
          giveaways: backend.services.giveaways
            .where((g) => g.guildId === guildId)
            .slice(-100)
            .reverse(),
        });
        return true;
      }

      if (rest === "moderation" && method === "POST") {
        requireCsrf(req, session);
        const body = await readJson(req);
        const action = body.action;
        if (typeof action !== "string" || typeof body.userId !== "string") {
          throw new HttpError(400, "action and userId are required");
        }
        if (!opts.operatorId) {
          throw new HttpError(
            400,
            "DASHBOARD_OPERATOR_ID is not set: a moderation action needs an attributable actor",
          );
        }
        const result = await backend.applyModeration({
          action: action as ModerationRequest["action"],
          guildId,
          userId: body.userId,
          reason: typeof body.reason === "string" ? body.reason : "no reason given",
          durationMs: typeof body.durationMs === "number" ? body.durationMs : undefined,
          moderatorId: opts.operatorId,
        });
        logger.info("dashboard moderation action", {
          guildId,
          action,
          caseNumber: result.caseNumber,
        });
        sendJson(res, 200, result);
        return true;
      }

      throw new HttpError(404, "not found");
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return true;
      }
      // An unexpected error is logged in full and reported without detail: a stack
      // trace or a Discord error string can carry an id or a token fragment.
      logger.error("dashboard request failed", {
        path,
        method,
        error: (err as Error).message,
      });
      sendJson(res, 500, { error: "internal error" });
      return true;
    }
  };
}
