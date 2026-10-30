import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CHANNEL_KEYS,
  FEATURE_KEYS,
  NUMBER_KEYS,
  ROLE_KEYS,
  TEXT_KEYS,
  nest,
} from "../src/bot/configKeys.js";
import { defaultGuildConfig, guildConfigSchema } from "../src/bot/guildConfig.js";
import { checkTarget } from "../src/bot/moderation.js";
import { AfkStore, ReminderStore } from "../src/bot/stores.js";
import { humanDuration } from "../src/bot/utility.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bot-mod-"));
}

describe("configKeys", () => {
  it("every key maps to a path the schema accepts", () => {
    // The whole point of the table is that it cannot drift from the schema. A path
    // that does not exist would only fail when an operator typed it.
    const base = defaultGuildConfig("123456789012345678");
    const all = [...TEXT_KEYS, ...NUMBER_KEYS, ...CHANNEL_KEYS, ...ROLE_KEYS];
    const record = base as unknown as Record<string, unknown>;
    for (const key of all) {
      const parts = key.path.split(".");
      // A single-segment path (`prefix`) is a top-level field, not a section.
      if (parts.length === 1) {
        assert.ok(
          Object.hasOwn(record, parts[0]),
          `${key.value}: "${parts[0]}" is not in the schema`,
        );
        continue;
      }
      const [section, field] = parts;
      const sectionValue = record[section] as Record<string, unknown> | undefined;
      assert.ok(
        sectionValue !== undefined,
        `${key.value}: section "${section}" is not in the schema`,
      );
      assert.ok(
        Object.hasOwn(sectionValue, field),
        `${key.value}: field "${field}" is not in section "${section}"`,
      );
    }
  });

  it("nest builds the patch shape patch() expects", () => {
    assert.deepEqual(nest("welcome.message", "hi"), { welcome: { message: "hi" } });
    assert.deepEqual(nest("prefix", "!"), { prefix: "!" });
  });

  it("nest output round-trips through the schema", () => {
    const base = defaultGuildConfig("123456789012345678");
    const merged = guildConfigSchema.parse({
      ...base,
      ...nest("welcome.message", "Bienvenue !"),
    });
    assert.equal(merged.welcome.message, "Bienvenue !");
  });

  it("feature keys match real sections of the schema", () => {
    const base = defaultGuildConfig("123456789012345678") as unknown as Record<string, unknown>;
    for (const f of FEATURE_KEYS) {
      assert.ok(Object.hasOwn(base, f.value), `${f.value} is not a config section`);
    }
  });

  it("rejects a value the schema refuses", () => {
    // A three-character prefix is the schema's limit; four must not be accepted.
    const base = defaultGuildConfig("123456789012345678");
    assert.throws(() => guildConfigSchema.parse({ ...base, ...nest("prefix", "!!!!") }));
  });
});

describe("checkTarget", () => {
  function member(opts: {
    id?: string;
    ownerId?: string;
    manageable?: boolean;
    topPosition?: number;
    perms?: string[];
  }) {
    // Real permission bits: the production code compares against
    // `PermissionFlagsBits`, so a mock keyed on names would answer false always.
    const perms: bigint[] =
      opts.perms === undefined
        ? [
            PermissionFlagsBits.BanMembers,
            PermissionFlagsBits.KickMembers,
            PermissionFlagsBits.ModerateMembers,
          ]
        : opts.perms.map((name) => PermissionFlagsBits[name as "BanMembers"]);
    return {
      id: opts.id ?? "1",
      user: { tag: `user#${opts.id ?? "1"}` },
      guild: { ownerId: opts.ownerId ?? "999" },
      manageable: opts.manageable ?? true,
      roles: { highest: { position: opts.topPosition ?? 1 } },
      permissions: { has: (p: bigint) => perms.includes(p) },
    } as never;
  }

  it("refuses to act on the server owner", () => {
    const me = member({ id: "bot" });
    const target = member({ id: "5", ownerId: "5" });
    const invoker = member({ id: "7", topPosition: 10 });
    const result = checkTarget(me, target, invoker, "ban");
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /propriétaire/);
  });

  it("refuses a target the bot cannot manage", () => {
    const me = member({ id: "bot" });
    const target = member({ id: "5", manageable: false });
    const invoker = member({ id: "7", topPosition: 10 });
    const result = checkTarget(me, target, invoker, "kick");
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /permission/);
  });

  it("refuses a target at or above the invoker", () => {
    const me = member({ id: "bot" });
    const target = member({ id: "5", topPosition: 10 });
    const invoker = member({ id: "7", topPosition: 10 });
    const result = checkTarget(me, target, invoker, "timeout");
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /égal ou supérieur/);
  });

  it("refuses self-moderation", () => {
    const me = member({ id: "bot" });
    const target = member({ id: "7" });
    const invoker = member({ id: "7", topPosition: 10 });
    const result = checkTarget(me, target, invoker, "warn");
    assert.equal(result.ok, false);
  });

  it("refuses when the bot lacks the permission", () => {
    const me = member({ id: "bot", perms: [] });
    const target = member({ id: "5" });
    const invoker = member({ id: "7", topPosition: 10 });
    const result = checkTarget(me, target, invoker, "ban");
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /Bannir/);
  });

  it("allows a lower-ranked target when the bot has the permission", () => {
    const me = member({ id: "bot" });
    const target = member({ id: "5", topPosition: 1 });
    const invoker = member({ id: "7", topPosition: 10 });
    assert.equal(checkTarget(me, target, invoker, "ban").ok, true);
  });

  it("lets the owner act on anyone below the bot", () => {
    const me = member({ id: "bot" });
    const target = member({ id: "5", topPosition: 50 });
    const invoker = member({ id: "999", topPosition: 1 });
    invoker.guild.ownerId = "999";
    assert.equal(checkTarget(me, target, invoker, "ban").ok, true);
  });
});

describe("AfkStore", () => {
  it("sets, reads and clears a record", async () => {
    const store = new AfkStore(join(await tempDir(), "afk.json"));
    await store.load();
    await store.set("111111111111111111", "222222222222222222", "au travail");
    assert.equal(store.for("111111111111111111", "222222222222222222")?.reason, "au travail");

    await store.remove((r) => r.userId === "222222222222222222");
    assert.equal(store.for("111111111111111111", "222222222222222222"), undefined);
  });

  it("replaces rather than duplicates on a second /afk", async () => {
    const store = new AfkStore(join(await tempDir(), "afk.json"));
    await store.load();
    await store.set("111111111111111111", "222222222222222222", "première");
    await store.set("111111111111111111", "222222222222222222", "deuxième");
    assert.equal(store.inGuild("111111111111111111").length, 1);
    assert.equal(store.for("111111111111111111", "222222222222222222")?.reason, "deuxième");
  });

  it("counts mentions", async () => {
    const store = new AfkStore(join(await tempDir(), "afk.json"));
    await store.load();
    await store.set("111111111111111111", "222222222222222222", "afk");
    assert.equal(await store.countMention("111111111111111111", "222222222222222222"), 1);
    assert.equal(await store.countMention("111111111111111111", "222222222222222222"), 2);
  });

  it("returns 0 mentions for someone who is not away", async () => {
    const store = new AfkStore(join(await tempDir(), "afk.json"));
    await store.load();
    assert.equal(await store.countMention("111111111111111111", "333333333333333333"), 0);
  });

  it("scopes records per guild", async () => {
    const store = new AfkStore(join(await tempDir(), "afk.json"));
    await store.load();
    await store.set("111111111111111111", "222222222222222222", "a");
    await store.set("999999999999999999", "222222222222222222", "b");
    assert.equal(store.inGuild("111111111111111111").length, 1);
    assert.equal(store.inGuild("111111111111111111")[0].reason, "a");
  });
});

describe("ReminderStore", () => {
  it("returns only due, unfired reminders", async () => {
    const store = new ReminderStore(join(await tempDir(), "reminders.json"));
    await store.load();
    const now = Date.now();
    const base = {
      guildId: "111111111111111111",
      channelId: "222222222222222222",
      userId: "333333333333333333",
      text: "test",
      createdAt: new Date(now).toISOString(),
      fired: false,
    };
    await store.addReminder({ ...base, id: "a", dueAt: now - 1000 });
    await store.addReminder({ ...base, id: "b", dueAt: now + 60_000 });

    const due = store.due(now);
    assert.equal(due.length, 1);
    assert.equal(due[0].id, "a");
  });

  it("does not fire a reminder twice", async () => {
    const store = new ReminderStore(join(await tempDir(), "reminders.json"));
    await store.load();
    const now = Date.now();
    await store.addReminder({
      id: "a",
      guildId: "111111111111111111",
      channelId: "222222222222222222",
      userId: "333333333333333333",
      text: "test",
      dueAt: now - 1000,
      createdAt: new Date(now).toISOString(),
      fired: false,
    });
    await store.markFired("a");
    assert.equal(store.due(now).length, 0);
  });

  it("lists pending reminders per member", async () => {
    const store = new ReminderStore(join(await tempDir(), "reminders.json"));
    await store.load();
    const now = Date.now();
    const base = {
      guildId: "111111111111111111",
      channelId: "222222222222222222",
      text: "test",
      createdAt: new Date(now).toISOString(),
      fired: false,
    };
    await store.addReminder({ ...base, id: "a", userId: "333333333333333333", dueAt: now + 1000 });
    await store.addReminder({ ...base, id: "b", userId: "444444444444444444", dueAt: now + 1000 });
    assert.equal(store.pendingFor("111111111111111111", "333333333333333333").length, 1);
  });

  it("prunes only old fired reminders", async () => {
    const store = new ReminderStore(join(await tempDir(), "reminders.json"));
    await store.load();
    const now = Date.now();
    await store.addReminder({
      id: "old",
      guildId: "111111111111111111",
      channelId: "222222222222222222",
      userId: "333333333333333333",
      text: "test",
      dueAt: now - 200_000_000,
      createdAt: new Date(now - 200_000_000).toISOString(),
      fired: true,
    });
    await store.addReminder({
      id: "pending",
      guildId: "111111111111111111",
      channelId: "222222222222222222",
      userId: "333333333333333333",
      text: "test",
      dueAt: now + 60_000,
      createdAt: new Date(now).toISOString(),
      fired: false,
    });
    const pruned = await store.pruneFired(now);
    assert.equal(pruned, 1);
    assert.equal(store.all().length, 1);
    assert.equal(store.all()[0].id, "pending");
  });
});

describe("humanDuration", () => {
  it("formats the units people use", () => {
    assert.equal(humanDuration(45_000), "45 s");
    assert.equal(humanDuration(90_000), "1 min");
    assert.equal(humanDuration(3_600_000), "1 h");
    assert.equal(humanDuration(90_000_000), "1 j 1 h");
  });

  it("never returns an empty string", () => {
    assert.equal(humanDuration(0), "0 s");
  });
});
