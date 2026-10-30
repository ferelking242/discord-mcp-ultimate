import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  accountAgeDays,
  canGrantRole,
  earnsXp,
  expandTemplate,
  levelForXp,
  levelProgress,
  matchAutoresponder,
  parseDuration,
  roleRewardsFor,
  rollXp,
  shouldGrantAutoroles,
  truncate,
  xpForLevel,
} from "../src/bot/features.js";
import {
  defaultGuildConfig,
  deepMerge,
  GuildConfigStore,
  guildConfigSchema,
} from "../src/bot/guildConfig.js";
import { JsonDocument } from "../src/bot/store.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "features-"));
}

// ─── templates ─────────────────────────────────────────────────────────────────

describe("expandTemplate", () => {
  it("expands the documented placeholders", () => {
    const text = expandTemplate("Bienvenue {username} sur {server}, membre #{memberCount}", {
      username: "ada",
      server: "Watchtower",
      memberCount: 42,
    });
    assert.equal(text, "Bienvenue ada sur Watchtower, membre #42");
  });

  it("renders a mention from a member-like object", () => {
    assert.equal(expandTemplate("{user}", { user: { id: "123" } as never }), "<@123>");
  });

  it("leaves an unknown placeholder alone so a typo is visible", () => {
    // Blanking it would make the message look like the bot is broken instead.
    assert.equal(expandTemplate("{usernam}", { username: "ada" }), "{usernam}");
  });

  it("renders an empty string when the member is absent", () => {
    assert.equal(expandTemplate("[{user}]", {}), "[]");
  });
});

// ─── role grantability ─────────────────────────────────────────────────────────

function fakeRole(over: Partial<{ name: string; managed: boolean; position: number }>) {
  return {
    name: over.name ?? "Role",
    managed: over.managed ?? false,
    position: over.position ?? 1,
  } as never;
}
function fakeBot(over: { highest: number; manageRoles?: boolean }) {
  return {
    permissions: { has: () => over.manageRoles ?? true },
    roles: { highest: { position: over.highest } },
  } as never;
}

describe("canGrantRole", () => {
  it("allows a normal role below the bot", () => {
    assert.deepEqual(canGrantRole(fakeBot({ highest: 5 }), fakeRole({ position: 3 })), {
      ok: true,
    });
  });

  it("refuses a managed role, which Discord will not let a bot grant", () => {
    const verdict = canGrantRole(fakeBot({ highest: 5 }), fakeRole({ position: 1, managed: true }));
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /managed/);
  });

  it("refuses a role above the bot, and says to move the bot up", () => {
    const verdict = canGrantRole(fakeBot({ highest: 5 }), fakeRole({ name: "Admin", position: 9 }));
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /above the bot's highest/);
  });

  it("refuses a role at exactly the bot's position, which Discord also rejects", () => {
    assert.equal(canGrantRole(fakeBot({ highest: 5 }), fakeRole({ position: 5 })).ok, false);
  });

  it("refuses when Manage Roles is missing", () => {
    const verdict = canGrantRole(
      fakeBot({ highest: 5, manageRoles: false }),
      fakeRole({ position: 1 }),
    );
    assert.match((verdict as { reason: string }).reason, /Manage Roles/);
  });
});

// ─── autorole ──────────────────────────────────────────────────────────────────

describe("shouldGrantAutoroles", () => {
  const base = defaultGuildConfig("111111111111111111");
  const member = (bot = false, createdDaysAgo = 400) =>
    ({
      user: {
        bot,
        createdAt: new Date(Date.now() - createdDaysAgo * 86_400_000),
      },
    }) as never;

  it("does nothing while the feature is off", () => {
    assert.equal(shouldGrantAutoroles(base, member()).grant, false);
  });

  it("grants the configured roles when enabled", () => {
    const cfg = guildConfigSchema.parse({
      guildId: "111111111111111111",
      autorole: { enabled: true, roleIds: ["222222222222222222"] },
    });
    assert.equal(shouldGrantAutoroles(cfg, member()).grant, true);
  });

  it("skips bots, since a bot with a member role is noise", () => {
    const cfg = guildConfigSchema.parse({
      guildId: "111111111111111111",
      autorole: { enabled: true, roleIds: ["222222222222222222"] },
    });
    const verdict = shouldGrantAutoroles(cfg, member(true));
    assert.equal(verdict.grant, false);
    assert.match(verdict.reason ?? "", /bot/);
  });

  it("holds back a fresh account when a minimum age is set", () => {
    const cfg = guildConfigSchema.parse({
      guildId: "111111111111111111",
      autorole: { enabled: true, roleIds: ["222222222222222222"], minAccountAgeDays: 7 },
    });
    const verdict = shouldGrantAutoroles(cfg, member(false, 2));
    assert.equal(verdict.grant, false);
    assert.match(verdict.reason ?? "", /2 day\(s\) old/);
  });

  it("grants once the account is old enough", () => {
    const cfg = guildConfigSchema.parse({
      guildId: "111111111111111111",
      autorole: { enabled: true, roleIds: ["222222222222222222"], minAccountAgeDays: 7 },
    });
    assert.equal(shouldGrantAutoroles(cfg, member(false, 30)).grant, true);
  });

  it("computes account age in whole days", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    assert.equal(accountAgeDays(new Date("2026-01-01T00:00:00Z"), now), 9);
  });
});

// ─── levels ────────────────────────────────────────────────────────────────────

describe("levels", () => {
  it("follows the MEE6 curve at the known points", () => {
    assert.equal(xpForLevel(0), 0);
    assert.equal(xpForLevel(1), 155);
    assert.equal(xpForLevel(2), 220);
  });

  it("inverts the curve", () => {
    for (const level of [0, 1, 2, 5, 12]) {
      assert.equal(levelForXp(xpForLevel(level)), level);
      // One XP short of the next threshold is still the current level.
      assert.equal(levelForXp(xpForLevel(level + 1) - 1), level);
      assert.equal(levelForXp(xpForLevel(level + 1)), level + 1);
    }
  });

  it("reports progress inside the current level", () => {
    const progress = levelProgress(xpForLevel(3) + 10);
    assert.equal(progress.level, 3);
    assert.equal(progress.intoLevel, 10);
    assert.ok(progress.percent >= 0 && progress.percent <= 100);
  });

  it("rolls XP inside the configured range, inclusive", () => {
    const cfg = guildConfigSchema.parse({
      guildId: "111111111111111111",
      levels: { xpMin: 5, xpMax: 5 },
    });
    assert.equal(rollXp(cfg), 5);
    assert.equal(
      rollXp(cfg, () => 0),
      5,
    );
    assert.equal(
      rollXp(cfg, () => 0.999),
      5,
    );
  });

  it("tolerates a reversed range rather than returning a negative", () => {
    const cfg = guildConfigSchema.parse({
      guildId: "111111111111111111",
      levels: { xpMin: 20, xpMax: 10 },
    });
    const rolled = rollXp(cfg, () => 0.5);
    assert.ok(rolled >= 10 && rolled <= 20, `got ${rolled}`);
  });

  it("refuses XP from bots, excluded channels and excluded roles", () => {
    const cfg = guildConfigSchema.parse({
      guildId: "111111111111111111",
      levels: {
        enabled: true,
        ignoredChannelIds: ["333333333333333333"],
        ignoredRoleIds: ["444444444444444444"],
      },
    });
    assert.equal(earnsXp(cfg, { isBot: true, channelId: "1", roleIds: [] }).earns, false);
    assert.equal(
      earnsXp(cfg, { isBot: false, channelId: "333333333333333333", roleIds: [] }).earns,
      false,
    );
    assert.equal(
      earnsXp(cfg, { isBot: false, channelId: "1", roleIds: ["444444444444444444"] }).earns,
      false,
    );
    assert.equal(earnsXp(cfg, { isBot: false, channelId: "1", roleIds: ["9"] }).earns, true);
  });

  it("does not award XP while the feature is off", () => {
    const cfg = defaultGuildConfig("111111111111111111");
    assert.equal(earnsXp(cfg, { isBot: false, channelId: "1", roleIds: [] }).earns, false);
  });

  it("returns only the rewards newly earned, so a role is not re-added", () => {
    const cfg = guildConfigSchema.parse({
      guildId: "111111111111111111",
      levels: {
        roleRewards: [
          { level: 1, roleId: "100000000000000001" },
          { level: 5, roleId: "100000000000000005" },
          { level: 10, roleId: "100000000000000010" },
        ],
      },
    });
    assert.deepEqual(roleRewardsFor(cfg, 5, ["100000000000000001"]), ["100000000000000005"]);
    assert.deepEqual(roleRewardsFor(cfg, 5, []), ["100000000000000001", "100000000000000005"]);
    assert.deepEqual(roleRewardsFor(cfg, 3, []), ["100000000000000001"]);
  });
});

// ─── autoresponder ─────────────────────────────────────────────────────────────

describe("matchAutoresponder", () => {
  const cfg = guildConfigSchema.parse({
    guildId: "111111111111111111",
    autoresponder: {
      enabled: true,
      rules: [
        { id: "r1", trigger: "bonjour", match: "contains", reply: "Salut !" },
        {
          id: "r2",
          trigger: "help",
          match: "exact",
          reply: "Aide",
          ignoreRoleId: "555555555555555555",
        },
      ],
    },
  });

  it("matches on contains, case-insensitively", () => {
    assert.equal(matchAutoresponder(cfg, "Bonjour tout le monde", []).rule?.id, "r1");
  });

  it("respects exact matching", () => {
    assert.equal(matchAutoresponder(cfg, "help me", []).rule, undefined);
    assert.equal(matchAutoresponder(cfg, "help", []).rule?.id, "r2");
  });

  it("lets an exempt role bypass a rule", () => {
    assert.equal(matchAutoresponder(cfg, "help", ["555555555555555555"]).rule, undefined);
  });

  it("does nothing when disabled", () => {
    const off = guildConfigSchema.parse({ guildId: "111111111111111111" });
    assert.equal(matchAutoresponder(off, "bonjour", []).rule, undefined);
  });

  it("returns the first matching rule, so order is meaningful", () => {
    const overlapping = guildConfigSchema.parse({
      guildId: "111111111111111111",
      autoresponder: {
        enabled: true,
        rules: [
          { id: "first", trigger: "salut", match: "contains", reply: "a" },
          { id: "second", trigger: "salut", match: "contains", reply: "b" },
        ],
      },
    });
    assert.equal(matchAutoresponder(overlapping, "salut", []).rule?.id, "first");
  });
});

// ─── durations ─────────────────────────────────────────────────────────────────

describe("parseDuration", () => {
  it("accepts the documented units", () => {
    assert.equal(parseDuration("30m"), 1_800_000);
    assert.equal(parseDuration("2h"), 7_200_000);
    assert.equal(parseDuration("1d"), 86_400_000);
    assert.equal(parseDuration("1w"), 604_800_000);
    assert.equal(parseDuration("45s"), 45_000);
  });

  it("treats a bare number as minutes", () => {
    assert.equal(parseDuration("10"), 600_000);
  });

  it("tolerates spacing and case", () => {
    assert.equal(parseDuration(" 5 M "), 300_000);
  });

  it("returns null rather than guessing, since a wrong timeout is worse than a refusal", () => {
    for (const bad of ["", "abc", "-5m", "0m", "1y", "5mm"]) {
      assert.equal(parseDuration(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe("truncate", () => {
  it("marks that it cut the text", () => {
    assert.equal(truncate("abcdef", 4), "abc…");
    assert.equal(truncate("abc", 10), "abc");
  });
});

// ─── config store ──────────────────────────────────────────────────────────────

describe("GuildConfigStore", () => {
  it("returns a fully-defaulted config for an unknown guild", () => {
    const store = new GuildConfigStore(join("/tmp", "does-not-matter.json"));
    const cfg = store.get("999999999999999999");
    assert.equal(cfg.guildId, "999999999999999999");
    assert.equal(cfg.welcome.enabled, false);
    assert.equal(cfg.levels.xpMin, 15);
    assert.equal(cfg.levels.xpMax, 25);
    assert.equal(store.isConfigured("999999999999999999"), false);
  });

  it("persists a patch and reloads it", async () => {
    const dir = await tempDir();
    const file = join(dir, "guild-config.json");
    const store = new GuildConfigStore(file);
    await store.load();
    await store.patch("111111111111111111", {
      welcome: { enabled: true, channelId: "222222222222222222" },
    });

    const reopened = new GuildConfigStore(file);
    await reopened.load();
    const cfg = reopened.get("111111111111111111");
    assert.equal(cfg.welcome.enabled, true);
    assert.equal(cfg.welcome.channelId, "222222222222222222");
    assert.equal(reopened.isConfigured("111111111111111111"), true);
  });

  it("merges a patch instead of replacing, so other sections survive", async () => {
    const dir = await tempDir();
    const store = new GuildConfigStore(join(dir, "c.json"));
    await store.load();
    await store.patch("111111111111111111", { levels: { enabled: true, xpMin: 40 } });
    await store.patch("111111111111111111", { welcome: { enabled: true } });

    const cfg = store.get("111111111111111111");
    assert.equal(cfg.welcome.enabled, true);
    assert.equal(cfg.levels.enabled, true);
    assert.equal(cfg.levels.xpMin, 40, "an earlier patch must not be wiped by a later one");
  });

  it("replaces an array rather than merging it, so a role can be removed", () => {
    const merged = deepMerge(
      { roleIds: ["a", "b", "c"] } as Record<string, unknown>,
      { roleIds: ["a"] } as never,
    ) as { roleIds: string[] };
    assert.deepEqual(merged.roleIds, ["a"]);
  });

  it("keeps the version field on disk, which an older build reads", async () => {
    const dir = await tempDir();
    const file = join(dir, "v.json");
    const store = new GuildConfigStore(file);
    await store.load();
    await store.patch("111111111111111111", { welcome: { enabled: true } });
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.version, 1);
  });

  it("rejects an invalid patch rather than storing it", async () => {
    const dir = await tempDir();
    const store = new GuildConfigStore(join(dir, "bad.json"));
    await store.load();
    await assert.rejects(
      store.patch("111111111111111111", { welcome: { channelId: "not-a-snowflake" } } as never),
    );
  });

  it("resets a guild back to defaults", async () => {
    const dir = await tempDir();
    const store = new GuildConfigStore(join(dir, "r.json"));
    await store.load();
    await store.patch("111111111111111111", { levels: { enabled: true } });
    await store.reset("111111111111111111");
    assert.equal(store.get("111111111111111111").levels.enabled, false);
    assert.deepEqual(store.guildIds(), []);
  });

  it("refuses to read a malformed file instead of silently using defaults", async () => {
    const dir = await tempDir();
    const file = join(dir, "broken.json");
    await writeFile(file, "{ not json", "utf8");
    const store = new GuildConfigStore(file);
    await assert.rejects(store.load(), /unreadable or malformed/);
  });

  it("treats a missing file as an empty store", async () => {
    const dir = await tempDir();
    const store = new GuildConfigStore(join(dir, "absent.json"));
    await store.load();
    assert.deepEqual(store.guildIds(), []);
  });
});

// ─── json document ─────────────────────────────────────────────────────────────

describe("JsonDocument", () => {
  it("writes atomically and leaves no temp file behind", async () => {
    const dir = await tempDir();
    const file = join(dir, "doc.json");
    const doc = new JsonDocument<{ n: number }>({
      file,
      create: () => ({ n: 0 }),
      normalize: (raw) => raw as { n: number },
    });
    await doc.load();
    await doc.update((d) => ({ n: d.n + 1 }));

    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { n: 1 });
    const files = await readFile(join(dir, "doc.json.tmp"), "utf8").catch(() => null);
    assert.equal(files, null, "the temp file must be renamed away, not left");
  });

  it("serializes concurrent updates so none is lost", async () => {
    const dir = await tempDir();
    const doc = new JsonDocument<{ items: number[] }>({
      file: join(dir, "d.json"),
      create: () => ({ items: [] }),
      normalize: (raw) => raw as { items: number[] },
    });
    await doc.load();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => doc.update((d) => ({ items: [...d.items, i] }))),
    );
    assert.equal(doc.get().items.length, 25);
  });

  it("coalesces writes when debounced, and flushes on demand", async () => {
    const dir = await tempDir();
    const file = join(dir, "deb.json");
    const doc = new JsonDocument<{ n: number }>({
      file,
      create: () => ({ n: 0 }),
      normalize: (raw) => raw as { n: number },
      debounceMs: 60_000,
    });
    await doc.load();
    for (let i = 0; i < 5; i++) await doc.update((d) => ({ n: d.n + 1 }));
    assert.equal(await readFile(file, "utf8").catch(() => null), null, "nothing written yet");
    await doc.flush();
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { n: 5 });
  });

  it("picks up a change made by the other process", async () => {
    const dir = await tempDir();
    const file = join(dir, "shared.json");
    const first = new JsonDocument<{ v: string }>({
      file,
      create: () => ({ v: "a" }),
      normalize: (raw) => raw as { v: string },
    });
    await first.load();
    await first.update(() => ({ v: "a" }));

    const second = new JsonDocument<{ v: string }>({
      file,
      create: () => ({ v: "a" }),
      normalize: (raw) => raw as { v: string },
    });
    await second.load();
    await second.update(() => ({ v: "b" }));

    assert.equal(first.get().v, "a");
    assert.equal(await first.reloadIfChanged(), true);
    assert.equal(first.get().v, "b");
    // mtime resolution can be coarse; the second call must not report a change.
    assert.equal(await first.reloadIfChanged(), false);
  });
});
