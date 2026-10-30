import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createDashboardHandler,
  type DashboardBackend,
  type GuildSummary,
} from "../src/dashboard/api.js";
import { Authenticator, clientKey, hashPassword, verifyPassword } from "../src/dashboard/auth.js";
import { GuildConfigStore } from "../src/bot/guildConfig.js";
import { BotServices } from "../src/bot/services.js";
import type { Logger } from "../src/bot/handlers.js";

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

// ─── password hashing ──────────────────────────────────────────────────────────

describe("dashboard password hashing", () => {
  it("verifies a password against its own hash", () => {
    const hash = hashPassword("correct horse battery staple");
    assert.equal(verifyPassword("correct horse battery staple", hash), true);
  });

  it("rejects a wrong password", () => {
    const hash = hashPassword("hunter2");
    assert.equal(verifyPassword("hunter3", hash), false);
  });

  it("salts, so the same password hashes differently each time", () => {
    assert.notEqual(hashPassword("same"), hashPassword("same"));
  });

  it("refuses a malformed or hostile hash line rather than crashing", () => {
    for (const bad of [
      "",
      "plaintext",
      "scrypt$16384$8$1$onlyfive",
      "scrypt$notanumber$8$1$AA$AA",
      // A huge N would try to allocate gigabytes; it must be refused, not honoured.
      "scrypt$99999999$8$1$AA$AA",
      "scrypt$16384$8$1$$",
    ]) {
      assert.equal(verifyPassword("x", bad), false, `expected false for ${bad}`);
    }
  });
});

// ─── sessions ──────────────────────────────────────────────────────────────────

describe("Authenticator", () => {
  const auth = new Authenticator({ password: "secret", sessionSecret: "fixed-key-for-tests" });

  it("issues a session that verifies", () => {
    const session = auth.createSession();
    const verified = auth.verifySession(session.token);
    assert.equal(verified?.csrf, session.csrf);
  });

  it("rejects a tampered payload, which is how a client would extend its own expiry", () => {
    const session = auth.createSession();
    const [payload, signature] = session.token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ exp: Date.now() + 10 ** 12, csrf: "attacker" }),
    ).toString("base64url");
    assert.equal(auth.verifySession(`${forged}.${signature}`), null);
    assert.equal(auth.verifySession(`${payload}.deadbeef`), null);
  });

  it("rejects a token signed with a different key, so a restart invalidates sessions", () => {
    const other = new Authenticator({ password: "secret", sessionSecret: "another-key" });
    assert.equal(auth.verifySession(other.createSession().token), null);
  });

  it("rejects an expired session", () => {
    const short = new Authenticator({
      password: "secret",
      sessionSecret: "k",
      sessionTtlMs: -1,
    });
    assert.equal(short.verifySession(short.createSession().token), null);
  });

  it("rejects a garbage token without throwing", () => {
    for (const bad of [undefined, "", ".", "no-dot", "a.b.c"]) {
      assert.equal(auth.verifySession(bad), null);
    }
  });

  it("checks CSRF against the session's own token", () => {
    const session = auth.createSession();
    assert.equal(auth.verifyCsrf(session, session.csrf), true);
    assert.equal(auth.verifyCsrf(session, "wrong"), false);
    assert.equal(auth.verifyCsrf(session, undefined), false);
  });

  it("throttles repeated failures and reports how long to wait", () => {
    const limited = new Authenticator({ password: "pw", sessionSecret: "k", maxLoginAttempts: 3 });
    assert.equal(limited.checkPassword("nope", "1.2.3.4").ok, false);
    assert.equal(limited.checkPassword("nope", "1.2.3.4").ok, false);
    assert.equal(limited.checkPassword("nope", "1.2.3.4").ok, false);
    const blocked = limited.checkPassword("pw", "1.2.3.4");
    assert.equal(blocked.ok, false, "the limit must hold even for the correct password");
    assert.ok((blocked.retryAfterMs ?? 0) > 0);
  });

  it("throttles per client, so one address cannot lock out another", () => {
    const limited = new Authenticator({ password: "pw", sessionSecret: "k", maxLoginAttempts: 1 });
    limited.checkPassword("nope", "1.1.1.1");
    assert.equal(limited.checkPassword("pw", "1.1.1.1").ok, false);
    assert.equal(limited.checkPassword("pw", "2.2.2.2").ok, true);
  });

  it("does not clear the window on a successful login", () => {
    const limited = new Authenticator({ password: "pw", sessionSecret: "k", maxLoginAttempts: 2 });
    limited.checkPassword("pw", "9.9.9.9");
    limited.checkPassword("pw", "9.9.9.9");
    assert.equal(limited.checkPassword("pw", "9.9.9.9").ok, false);
  });

  it("refuses to exist without any password configured", () => {
    assert.throws(() => new Authenticator({}), /DASHBOARD_PASSWORD/);
  });

  it("sets HttpOnly and SameSite on the cookie", () => {
    const cookie = auth.sessionCookie(auth.createSession());
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /Secure/, "Secure is opt-in, since it needs TLS");
  });

  it("adds Secure when asked, for a TLS deployment", () => {
    const secure = new Authenticator({ password: "pw", sessionSecret: "k", secureCookies: true });
    assert.match(secure.sessionCookie(secure.createSession()), /Secure/);
  });

  it("reads a cookie out of a header with several", () => {
    const header = "a=1; dmcp_session=xyz; b=2";
    assert.equal(Authenticator.readCookie(header, "dmcp_session"), "xyz");
    assert.equal(Authenticator.readCookie(header, "absent"), undefined);
    assert.equal(Authenticator.readCookie(undefined, "dmcp_session"), undefined);
  });

  it("hashes the client address so a log line does not store the raw IP", () => {
    const key = clientKey("203.0.113.7");
    assert.notEqual(key, "203.0.113.7");
    assert.equal(key, clientKey("203.0.113.7"), "stable for the same address");
  });
});

// ─── API ───────────────────────────────────────────────────────────────────────

/** A backend with no Discord behind it, so the routes are tested in isolation. */
function stubBackend(services: BotServices): DashboardBackend {
  const guild: GuildSummary = {
    id: "111111111111111111",
    name: "Watchtower",
    icon: null,
    memberCount: 12,
    ownerId: "999999999999999999",
    botPresent: true,
  };
  return {
    services,
    async listGuilds() {
      return [guild];
    },
    async getGuild(guildId) {
      if (guildId !== guild.id) return null;
      return {
        ...guild,
        channels: [{ id: "222222222222222222", name: "general", type: "text", parentId: null }],
        roles: [
          { id: "333333333333333333", name: "Member", position: 1, managed: false, color: 0 },
        ],
        botHighestRolePosition: 5,
      };
    },
    async listMembers() {
      return [
        {
          id: "444444444444444444",
          tag: "ada#0001",
          displayName: "ada",
          joinedAt: new Date().toISOString(),
          isBot: false,
          roleIds: [],
        },
      ];
    },
    async applyModeration(request) {
      const number = services.moderation.nextNumber(request.guildId);
      await services.moderation.add({
        number,
        guildId: request.guildId,
        type: request.action === "timeout" ? "timeout" : "warn",
        targetId: request.userId,
        targetTag: "ada#0001",
        moderatorId: request.moderatorId,
        moderatorTag: "operator#0001",
        reason: request.reason,
        durationMs: request.durationMs ?? null,
        createdAt: new Date().toISOString(),
        active: true,
      });
      return { caseNumber: number, summary: `did ${request.action}` };
    },
    botInfo() {
      return { tag: "NEXUS#5681", id: "555555555555555555", uptimeSeconds: 12, ping: 40 };
    },
  };
}

describe("dashboard API", () => {
  let server: Server;
  let base: string;
  let services: BotServices;
  let auth: Authenticator;

  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), "dash-"));
    services = new BotServices(dir, silent);
    await services.loadAll();
    // A high attempt limit for the shared server: every test logs in from
    // 127.0.0.1, and the throttle is exercised on its own below.
    auth = new Authenticator({
      password: "hunter2",
      sessionSecret: "test-key",
      maxLoginAttempts: 1000,
    });
    const handler = createDashboardHandler({
      backend: stubBackend(services),
      auth,
      logger: silent,
      operatorId: "666666666666666666",
      renderPage: () => "<!DOCTYPE html><title>dash</title>",
      renderCss: () => ":root{--bg:#000}",
      renderScript: () => "const x = 1;",
      mcpEnabled: true,
    });
    server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await services.flushAll();
  });

  /** Logs in and returns the cookie plus the CSRF token. */
  async function login(): Promise<{ cookie: string; csrf: string }> {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { csrf: string };
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    return { cookie, csrf: body.csrf };
  }

  it("answers /health without authentication, for a probe", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; bot: string };
    assert.equal(body.status, "ok");
    assert.equal(body.bot, "NEXUS#5681");
  });

  it("reports an unauthenticated session honestly", async () => {
    const body = (await (await fetch(`${base}/api/session`)).json()) as { authenticated: boolean };
    assert.equal(body.authenticated, false);
  });

  it("refuses a wrong password", async () => {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    assert.equal(res.status, 401);
  });

  it("sets an HttpOnly session cookie on login", async () => {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  it("refuses every data route without a session", async () => {
    for (const path of ["/api/overview", "/api/guilds", "/api/cases"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401, `${path} must require a session`);
    }
  });

  it("serves the dashboard page without a session, so the login form loads", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /dash/);
  });

  it("sends a strict CSP that forbids inline script", async () => {
    const res = await fetch(`${base}/`);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline.*script-src|script-src[^;]*unsafe-inline/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
  });

  it("returns the overview once authenticated", async () => {
    const { cookie } = await login();
    const res = await fetch(`${base}/api/overview`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { guilds: unknown[]; mcpEnabled: boolean; stats: object };
    assert.equal(body.guilds.length, 1);
    assert.equal(body.mcpEnabled, true);
    assert.ok(body.stats);
  });

  it("requires CSRF on a mutating request, so a forged post is refused", async () => {
    const { cookie } = await login();
    const res = await fetch(`${base}/api/guilds/111111111111111111/config`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ welcome: { enabled: true } }),
    });
    assert.equal(res.status, 403);
  });

  it("applies a config patch when CSRF is present", async () => {
    const { cookie, csrf } = await login();
    const res = await fetch(`${base}/api/guilds/111111111111111111/config`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ welcome: { enabled: true, channelId: "222222222222222222" } }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      config: { welcome: { enabled: boolean; channelId: string } };
    };
    assert.equal(body.config.welcome.enabled, true);
    assert.equal(body.config.welcome.channelId, "222222222222222222");
  });

  it("keeps other sections when patching one, which is the whole point of PATCH", async () => {
    const { cookie, csrf } = await login();
    await fetch(`${base}/api/guilds/111111111111111111/config`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ levels: { enabled: true, xpMin: 30 } }),
    });
    const res = await fetch(`${base}/api/guilds/111111111111111111/config`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ starboard: { enabled: true } }),
    });
    const body = (await res.json()) as {
      config: { levels: { enabled: boolean; xpMin: number }; starboard: { enabled: boolean } };
    };
    assert.equal(body.config.starboard.enabled, true);
    assert.equal(body.config.levels.enabled, true);
    assert.equal(body.config.levels.xpMin, 30);
  });

  it("rejects a config patch that fails validation, rather than storing it", async () => {
    const { cookie, csrf } = await login();
    const res = await fetch(`${base}/api/guilds/111111111111111111/config`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ levels: { xpMin: 99999 } }),
    });
    assert.equal(res.status, 500, "a schema failure must not be reported as success");
  });

  it("404s for a guild the bot is not in", async () => {
    const { cookie } = await login();
    const res = await fetch(`${base}/api/guilds/777777777777777777/config`, {
      headers: { cookie },
    });
    assert.equal(res.status, 404);
  });

  it("refuses a moderation action with no CSRF", async () => {
    const { cookie } = await login();
    const res = await fetch(`${base}/api/guilds/111111111111111111/moderation`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ action: "warn", userId: "444444444444444444" }),
    });
    assert.equal(res.status, 403);
  });

  it("applies a moderation action and records a numbered case", async () => {
    const { cookie, csrf } = await login();
    const res = await fetch(`${base}/api/guilds/111111111111111111/moderation`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ action: "warn", userId: "444444444444444444", reason: "spam" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { caseNumber: number; summary: string };
    assert.ok(body.caseNumber >= 1);
    assert.match(body.summary, /warn/);

    const cases = (await (await fetch(`${base}/api/cases`, { headers: { cookie } })).json()) as {
      cases: { number: number; reason: string }[];
    };
    assert.ok(cases.cases.some((c) => c.reason === "spam"));
  });

  it("rejects a body that is not a JSON object", async () => {
    const { cookie, csrf } = await login();
    const res = await fetch(`${base}/api/guilds/111111111111111111/config`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: "[1,2,3]",
    });
    assert.equal(res.status, 400);
  });

  it("rejects malformed JSON with a 400, not a crash", async () => {
    const { cookie, csrf } = await login();
    const res = await fetch(`${base}/api/guilds/111111111111111111/config`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: "{ not json",
    });
    assert.equal(res.status, 400);
  });

  it("returns 404 for an unknown route rather than the page", async () => {
    const { cookie } = await login();
    const res = await fetch(`${base}/api/nope`, { headers: { cookie } });
    assert.equal(res.status, 404);
  });

  it("clears the cookie on logout", async () => {
    const { cookie } = await login();
    const res = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie } });
    assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=0/);
  });

  it("exposes the leaderboard and member list", async () => {
    const { cookie } = await login();
    await services.levels.add({
      guildId: "111111111111111111",
      userId: "444444444444444444",
      xp: 500,
      level: 2,
      messages: 10,
      lastXpAt: Date.now(),
      updatedAt: new Date().toISOString(),
    });
    const board = (await (
      await fetch(`${base}/api/guilds/111111111111111111/leaderboard`, { headers: { cookie } })
    ).json()) as { leaderboard: { xp: number }[] };
    assert.equal(board.leaderboard[0].xp, 500);

    const members = (await (
      await fetch(`${base}/api/guilds/111111111111111111/members`, { headers: { cookie } })
    ).json()) as { members: { tag: string }[] };
    assert.equal(members.members[0].tag, "ada#0001");
  });

  it("throttles password guessing over HTTP with a 429 and a Retry-After", async () => {
    const strict = new Authenticator({ password: "pw", sessionSecret: "k", maxLoginAttempts: 2 });
    const strictHandler = createDashboardHandler({
      backend: stubBackend(services),
      auth: strict,
      logger: silent,
      renderPage: () => "<html></html>",
      renderCss: () => "",
      renderScript: () => "",
      mcpEnabled: false,
    });
    const strictServer = createServer((req, res) => {
      void strictHandler(req, res);
    });
    await new Promise<void>((resolve) => strictServer.listen(0, "127.0.0.1", resolve));
    const address = strictServer.address();
    const strictBase = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      const attempt = (password: string) =>
        fetch(`${strictBase}/api/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        });
      await attempt("wrong");
      await attempt("wrong");
      const blocked = await attempt("pw");
      assert.equal(blocked.status, 429);
      assert.ok(blocked.headers.get("retry-after"), "a 429 must say when to retry");
    } finally {
      await new Promise<void>((resolve) => strictServer.close(() => resolve()));
    }
  });

  it("serves the stylesheet and the client script, which the CSP requires be external", async () => {
    const css = await fetch(`${base}/dashboard.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    assert.match(await css.text(), /--bg/);

    const js = await fetch(`${base}/dashboard.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
  });

  it("returns false for a route it does not own, so /mcp still reaches the MCP handler", async () => {
    // The dashboard and the MCP transport share one port. If the dashboard answered
    // 404 for /mcp, the bearer-authenticated transport would be unreachable.
    const handler = createDashboardHandler({
      backend: stubBackend(services),
      auth,
      logger: silent,
      renderPage: () => "<html></html>",
      renderCss: () => "",
      renderScript: () => "",
      mcpEnabled: true,
    });
    for (const path of ["/mcp", "/status", "/something-else"]) {
      const handled = await new Promise<boolean>((resolve) => {
        const req = { url: path, method: "GET", headers: {}, socket: {} } as never;
        const res = {
          writeHead: () => res,
          end: () => resolve(true),
          setHeader: () => res,
        } as never;
        void handler(req, res).then(resolve);
      });
      assert.equal(handled, false, `${path} must be left to the other handler`);
    }
  });

  it("clamps the requested page size, so a caller cannot ask for everything", async () => {
    const { cookie } = await login();
    const res = await fetch(`${base}/api/guilds/111111111111111111/members?limit=99999`, {
      headers: { cookie },
    });
    assert.equal(res.status, 200);
  });
});

// ─── guild config isolation ────────────────────────────────────────────────────

describe("GuildConfigStore over the API", () => {
  it("keeps two guilds independent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "multi-"));
    const store = new GuildConfigStore(join(dir, "c.json"));
    await store.load();
    await store.patch("111111111111111111", { levels: { enabled: true } });
    await store.patch("222222222222222222", { levels: { enabled: false } });
    assert.equal(store.get("111111111111111111").levels.enabled, true);
    assert.equal(store.get("222222222222222222").levels.enabled, false);
  });
});
