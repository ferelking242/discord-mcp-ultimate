import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { loadConfig } from "../src/bot/config.js";
import { ReactionRoleHandlers } from "../src/bot/handlers.js";
import { SlidingWindowLimiter } from "../src/bot/rateLimit.js";
import { ReactionRoleStore, normalizeEmoji } from "../src/bot/reactionRoles.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "rr-"));
  return new ReactionRoleStore(join(dir, "reaction-roles.json"));
}

// ─── config ────────────────────────────────────────────────────────────────────

describe("bot config", () => {
  it("requires a token", () => {
    assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /DISCORD_TOKEN is required/);
  });

  it("refuses HTTP without a token, because the control plane would be open", () => {
    assert.throws(
      () => loadConfig({ DISCORD_TOKEN: "t", MCP_HTTP_ENABLED: "true" } as NodeJS.ProcessEnv),
      /MCP_HTTP_TOKEN is required/,
    );
  });

  it("leaves HTTP off unless it is asked for, so nothing is exposed by default", () => {
    const cfg = loadConfig({ DISCORD_TOKEN: "t" } as NodeJS.ProcessEnv);
    assert.equal(cfg.httpEnabled, false);
  });

  it("parses booleans and numbers from strings", () => {
    const cfg = loadConfig({
      DISCORD_TOKEN: "t",
      MCP_HTTP_ENABLED: "false",
      BOT_WELCOME_DM: "yes",
      MCP_HTTP_PORT: "8080",
      DISCORD_ALLOWED_GUILDS: "1, 2 ,3",
    } as NodeJS.ProcessEnv);
    assert.equal(cfg.httpEnabled, false);
    assert.equal(cfg.welcomeDm, true);
    assert.equal(cfg.httpPort, 8080);
    assert.deepEqual(cfg.allowedGuilds, ["1", "2", "3"]);
  });

  it("rejects a non-numeric port instead of silently defaulting", () => {
    assert.throws(
      () => loadConfig({ DISCORD_TOKEN: "t", MCP_HTTP_PORT: "abc" } as NodeJS.ProcessEnv),
      /positive integer/,
    );
  });

  it("defaults the reaction mode to toggle", () => {
    const cfg = loadConfig({ DISCORD_TOKEN: "t" } as NodeJS.ProcessEnv);
    assert.equal(cfg.reactionMode, "toggle");
  });
});

// ─── limiter ───────────────────────────────────────────────────────────────────

describe("sliding window limiter", () => {
  it("allows up to the limit then blocks", () => {
    const now = 0;
    const l = new SlidingWindowLimiter(3, 1000, () => now);
    assert.equal(l.allow("m"), true);
    assert.equal(l.allow("m"), true);
    assert.equal(l.allow("m"), true);
    assert.equal(l.allow("m"), false);
  });

  it("lets the window expire", () => {
    let now = 0;
    const l = new SlidingWindowLimiter(1, 1000, () => now);
    assert.equal(l.allow("m"), true);
    assert.equal(l.allow("m"), false);
    now = 1001;
    assert.equal(l.allow("m"), true);
  });

  it("keys are independent, so one member cannot throttle another", () => {
    const l = new SlidingWindowLimiter(1, 1000);
    assert.equal(l.allow("a"), true);
    assert.equal(l.allow("b"), true);
    assert.equal(l.allow("a"), false);
  });

  it("reports the wait and prunes expired keys", () => {
    let now = 0;
    const l = new SlidingWindowLimiter(1, 1000, () => now);
    l.allow("a");
    assert.equal(l.retryAfterMs("a"), 1000);
    now += 1500;
    assert.equal(l.retryAfterMs("a"), 0);
    l.prune();
    assert.equal(l.size, 0);
  });
});

// ─── store ─────────────────────────────────────────────────────────────────────

describe("reaction-role store", () => {
  it("round-trips through disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rr-"));
    const file = join(dir, "rr.json");
    const a = new ReactionRoleStore(file);
    await a.load();
    await a.add({
      guildId: "1",
      channelId: "2",
      messageId: "3",
      emoji: "✅",
      roleId: "4",
      label: "x",
    });

    const b = new ReactionRoleStore(file);
    await b.load();
    assert.equal(b.all().length, 1);
    assert.equal(b.find("1", "2", "3", "✅")?.roleId, "4");
  });

  it("replaces the role when the same triple is added twice", async () => {
    const s = await tempStore();
    await s.load();
    await s.add({ guildId: "1", channelId: "2", messageId: "3", emoji: "✅", roleId: "4" });
    await s.add({ guildId: "1", channelId: "2", messageId: "3", emoji: "✅", roleId: "5" });
    assert.equal(s.all().length, 1);
    assert.equal(s.find("1", "2", "3", "✅")?.roleId, "5");
  });

  it("matches a custom emoji by name, not by id", async () => {
    const s = await tempStore();
    await s.load();
    await s.add({ guildId: "1", channelId: "2", messageId: "3", emoji: ":pepe:", roleId: "4" });
    assert.ok(s.find("1", "2", "3", "<:pepe:123456789>"));
  });

  it("removes a whole message's mappings and reports the count", async () => {
    const s = await tempStore();
    await s.load();
    await s.add({ guildId: "1", channelId: "2", messageId: "3", emoji: "a", roleId: "4" });
    await s.add({ guildId: "1", channelId: "2", messageId: "3", emoji: "b", roleId: "5" });
    assert.equal(await s.removeMessage("2", "3"), 2);
    assert.equal(s.all().length, 0);
  });

  it("starts empty when the file does not exist", async () => {
    const s = await tempStore();
    await s.load();
    assert.deepEqual(s.all(), []);
  });

  it("fails loudly on a malformed file instead of silently dropping menus", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rr-"));
    const file = join(dir, "rr.json");
    await writeFile(file, "{ not json", "utf8");
    const s = new ReactionRoleStore(file);
    await assert.rejects(() => s.load(), /unreadable or malformed/);
  });

  it("writes valid JSON that a second reader can parse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rr-"));
    const file = join(dir, "rr.json");
    const s = new ReactionRoleStore(file);
    await s.load();
    await s.add({ guildId: "1", channelId: "2", messageId: "3", emoji: "✅", roleId: "4" });
    const parsed = JSON.parse(await readFile(file, "utf8"));
    assert.equal(parsed.version, 1);
    assert.equal(parsed.mappings.length, 1);
  });

  it("reloads when the file changes underneath it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rr-"));
    const file = join(dir, "rr.json");
    const writer = new ReactionRoleStore(file);
    await writer.load();
    const reader = new ReactionRoleStore(file);
    await reader.load();
    assert.equal(reader.all().length, 0);

    await writer.add({ guildId: "1", channelId: "2", messageId: "3", emoji: "✅", roleId: "4" });
    assert.equal(await reader.reloadIfChanged(), true);
    assert.equal(reader.all().length, 1);
  });

  it("normalizes emoji forms consistently", () => {
    assert.equal(normalizeEmoji("<:pepe:123456789>"), ":pepe:");
    assert.equal(normalizeEmoji("<a:spin:123456789>"), ":spin:");
    assert.equal(normalizeEmoji(" ✅ "), "✅");
  });
});

// ─── handlers ──────────────────────────────────────────────────────────────────

/** Builds the minimum guild/member/reaction shapes the handler touches. */
function fakeGuild(opts: {
  id?: string;
  rolePosition?: number;
  botHighest?: number;
  managed?: boolean;
  hasManageRoles?: boolean;
  memberHasRole?: boolean;
}) {
  const role = {
    id: "role-1",
    name: "Test Role",
    position: opts.rolePosition ?? 1,
    managed: opts.managed ?? false,
  };
  const me = {
    roles: { highest: { position: opts.botHighest ?? 10 } },
    permissions: { has: () => opts.hasManageRoles ?? true },
  };
  const added: string[] = [];
  const removed: string[] = [];
  const member = {
    id: "user-1",
    roles: {
      add: async (r: { id: string }) => void added.push(r.id),
      remove: async (r: { id: string }) => void removed.push(r.id),
      cache: { has: () => opts.memberHasRole ?? false },
    },
  };
  const guild = {
    id: opts.id ?? "guild-1",
    roles: { cache: new Map([[role.id, role]]), fetch: async () => role },
    members: { me, fetch: async () => member },
  };
  return { guild, member, added, removed };
}

function fakeReaction(guild: unknown, emoji = "✅") {
  return {
    emoji: { id: null, name: emoji },
    message: { partial: false, id: "msg-1", channelId: "chan-1", guild },
  };
}

function handlers(
  store: ReactionRoleStore,
  over: Partial<ConstructorParameters<typeof ReactionRoleHandlers>[0]> = {},
) {
  return new ReactionRoleHandlers({
    store,
    logger: silent,
    mode: "toggle",
    limiter: new SlidingWindowLimiter(100, 1000),
    isGuildAllowed: () => true,
    welcome: { enabled: false, message: "hi" },
    ...over,
  });
}

describe("reaction-role handlers", () => {
  const user = { id: "user-1", bot: false };

  it("grants the mapped role", async () => {
    const store = await tempStore();
    await store.load();
    await store.add({
      guildId: "guild-1",
      channelId: "chan-1",
      messageId: "msg-1",
      emoji: "✅",
      roleId: "role-1",
    });
    const { guild, added } = fakeGuild({});
    const out = await handlers(store).onReactionAdd(fakeReaction(guild) as never, user as never);
    assert.match(out, /granted/);
    assert.deepEqual(added, ["role-1"]);
  });

  it("ignores an emoji with no mapping", async () => {
    const store = await tempStore();
    await store.load();
    const { guild, added } = fakeGuild({});
    const out = await handlers(store).onReactionAdd(
      fakeReaction(guild, "🔥") as never,
      user as never,
    );
    assert.match(out, /no mapping/);
    assert.equal(added.length, 0);
  });

  it("ignores bots, so the bot's own reaction does not grant it a role", async () => {
    const store = await tempStore();
    await store.load();
    const { guild } = fakeGuild({});
    const out = await handlers(store).onReactionAdd(
      fakeReaction(guild) as never,
      { id: "b", bot: true } as never,
    );
    assert.match(out, /bot user/);
  });

  it("refuses a role above the bot, with the reason, instead of a silent 50013", async () => {
    const store = await tempStore();
    await store.load();
    await store.add({
      guildId: "guild-1",
      channelId: "chan-1",
      messageId: "msg-1",
      emoji: "✅",
      roleId: "role-1",
    });
    const { guild, added } = fakeGuild({ rolePosition: 20, botHighest: 10 });
    const out = await handlers(store).onReactionAdd(fakeReaction(guild) as never, user as never);
    assert.match(out, /above the bot's highest role/);
    assert.equal(added.length, 0);
  });

  it("refuses a managed role", async () => {
    const store = await tempStore();
    await store.load();
    await store.add({
      guildId: "guild-1",
      channelId: "chan-1",
      messageId: "msg-1",
      emoji: "✅",
      roleId: "role-1",
    });
    const { guild } = fakeGuild({ managed: true });
    const out = await handlers(store).onReactionAdd(fakeReaction(guild) as never, user as never);
    assert.match(out, /managed by an integration/);
  });

  it("reports a missing ManageRoles permission", async () => {
    const store = await tempStore();
    await store.load();
    await store.add({
      guildId: "guild-1",
      channelId: "chan-1",
      messageId: "msg-1",
      emoji: "✅",
      roleId: "role-1",
    });
    const { guild } = fakeGuild({ hasManageRoles: false });
    const out = await handlers(store).onReactionAdd(fakeReaction(guild) as never, user as never);
    assert.match(out, /lacks ManageRoles/);
  });

  it("respects the guild allow-list", async () => {
    const store = await tempStore();
    await store.load();
    await store.add({
      guildId: "guild-1",
      channelId: "chan-1",
      messageId: "msg-1",
      emoji: "✅",
      roleId: "role-1",
    });
    const { guild, added } = fakeGuild({});
    const h = handlers(store, { isGuildAllowed: () => false });
    const out = await h.onReactionAdd(fakeReaction(guild) as never, user as never);
    assert.match(out, /not allow-listed/);
    assert.equal(added.length, 0);
  });

  it("throttles a member who hammers reactions", async () => {
    const store = await tempStore();
    await store.load();
    await store.add({
      guildId: "guild-1",
      channelId: "chan-1",
      messageId: "msg-1",
      emoji: "✅",
      roleId: "role-1",
    });
    const { guild } = fakeGuild({});
    const h = handlers(store, { limiter: new SlidingWindowLimiter(1, 10_000) });
    assert.match(await h.onReactionAdd(fakeReaction(guild) as never, user as never), /granted/);
    assert.match(await h.onReactionAdd(fakeReaction(guild) as never, user as never), /throttled/);
  });

  it("removes the role on unreact in toggle mode", async () => {
    const store = await tempStore();
    await store.load();
    await store.add({
      guildId: "guild-1",
      channelId: "chan-1",
      messageId: "msg-1",
      emoji: "✅",
      roleId: "role-1",
    });
    const { guild, removed } = fakeGuild({ memberHasRole: true });
    const out = await handlers(store).onReactionRemove(fakeReaction(guild) as never, user as never);
    assert.match(out, /removed/);
    assert.deepEqual(removed, ["role-1"]);
  });

  it("does not remove in add-only mode", async () => {
    const store = await tempStore();
    await store.load();
    await store.add({
      guildId: "guild-1",
      channelId: "chan-1",
      messageId: "msg-1",
      emoji: "✅",
      roleId: "role-1",
    });
    const { guild, removed } = fakeGuild({ memberHasRole: true });
    const out = await handlers(store, { mode: "add-only" }).onReactionRemove(
      fakeReaction(guild) as never,
      user as never,
    );
    assert.match(out, /add-only/);
    assert.equal(removed.length, 0);
  });

  it("sends no welcome DM when disabled", async () => {
    const store = await tempStore();
    await store.load();
    const h = handlers(store);
    const out = await h.onMemberJoin({
      id: "u",
      guild: { id: "guild-1" },
      send: async () => {},
    } as never);
    assert.match(out, /welcome DM disabled/);
  });

  it("sends the welcome DM, including the invite, when enabled", async () => {
    const store = await tempStore();
    await store.load();
    const sent: string[] = [];
    const h = handlers(store, {
      welcome: { enabled: true, message: "hello", inviteUrl: "https://x" },
    });
    const out = await h.onMemberJoin({
      id: "u",
      guild: { id: "guild-1" },
      send: async (t: string) => void sent.push(t),
    } as never);
    assert.match(out, /welcomed/);
    assert.match(sent[0], /hello/);
    assert.match(sent[0], /https:\/\/x/);
  });

  it("treats closed DMs as a skip, not an error", async () => {
    const store = await tempStore();
    await store.load();
    const h = handlers(store, { welcome: { enabled: true, message: "hello" } });
    const out = await h.onMemberJoin({
      id: "u",
      guild: { id: "guild-1" },
      send: async () => {
        throw new Error("Cannot send messages to this user");
      },
    } as never);
    assert.match(out, /DMs closed/);
  });
});

afterEach(() => {
  // No shared state between cases: every store lives in its own temp dir.
});
