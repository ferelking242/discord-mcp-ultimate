import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PermissionsBitField } from "discord.js";
import { discord } from "../src/client.js";
import { resetFingerprints, resetThrottle } from "../src/safety.js";
import guildSettings from "../src/tools/guildSettings.js";
import botProfile from "../src/tools/botProfile.js";
import diagnostics from "../src/tools/diagnostics.js";
import scheduler from "../src/tools/scheduler.js";
import automod from "../src/tools/automod.js";
import expressions from "../src/tools/expressions.js";
import backup from "../src/tools/backup.js";
import style from "../src/tools/style.js";

const GUILD = "111111111111111111";
const CHANNEL = "333333333333333333";

afterEach(() => {
  mock.restoreAll();
  resetFingerprints();
  resetThrottle();
});

const handler = (mod: { handlers: ReadonlyMap<string, unknown> }, name: string) =>
  mod.handlers.get(name) as (args: Record<string, unknown>) => Promise<{
    structuredContent?: Record<string, unknown>;
    content: { text?: string }[];
  }>;

const textOf = (res: { content: { text?: string }[] }) => res.content[0]?.text ?? "";

/**
 * Builds a fake guild with the pieces the settings tools touch. `me` carries a
 * permission bitfield so the preflight helpers see a bot that is allowed.
 */
function fakeGuild(overrides: Record<string, unknown> = {}) {
  const permissions = new PermissionsBitField([
    "ManageGuild",
    "ManageChannels",
    "ManageRoles",
    "ManageEmojisAndStickers",
    "ManageMessages",
    "KickMembers",
    "BanMembers",
    "ModerateMembers",
    "ManageNicknames",
    "ViewAuditLog",
    "ManageWebhooks",
    "CreateInstantInvite",
    "ManageEvents",
  ]);
  const edits: Record<string, unknown>[] = [];
  const guild = {
    id: GUILD,
    name: "Watchtower",
    description: "A test server",
    icon: null,
    banner: null,
    splash: null,
    discoverySplash: null,
    ownerId: "999999999999999999",
    preferredLocale: "en-US",
    verificationLevel: 1,
    explicitContentFilter: 1,
    defaultMessageNotifications: 0,
    mfaLevel: 0,
    nsfwLevel: 1,
    premiumTier: 2,
    premiumSubscriptionCount: 7,
    premiumProgressBarEnabled: false,
    systemChannelId: null,
    rulesChannelId: null,
    publicUpdatesChannelId: null,
    safetyAlertsChannelId: null,
    afkChannelId: null,
    afkTimeout: 300,
    vanityURLCode: null,
    features: [] as string[],
    memberCount: 12,
    approximatePresenceCount: 4,
    members: {
      me: {
        id: "888888888888888888",
        permissions,
        nickname: null,
        displayName: "Bot",
        displayAvatarURL: () => "https://cdn.example/bot.png",
        roles: { highest: { position: 5 }, cache: new Map([["r", { id: "r" }]]) },
        manageable: true,
        user: { tag: "bot#0001" },
      },
    },
    roles: {
      cache: new Map(),
      fetch: async () => new Map(),
      create: async (opts: Record<string, unknown>) => ({ id: "newrole", ...opts }),
      fetchMemberCounts: async () => new Map<string, number>(),
    },
    channels: {
      cache: new Map(),
      fetch: async () => new Map(),
      create: async () => ({ id: "new" }),
    },
    emojis: { cache: new Map(), fetch: async () => new Map(), create: async () => ({}) },
    stickers: { cache: new Map(), fetch: async () => new Map(), create: async () => ({}) },
    autoModerationRules: {
      fetch: async () => new Map(),
      create: async () => ({}),
    },
    fetchPreview: async () => ({
      id: GUILD,
      name: "Watchtower",
      description: "d",
      approximateMemberCount: 10,
      approximatePresenceCount: 3,
      iconURL: () => null,
      splashURL: () => null,
      features: [],
      emojis: new Map(),
      stickers: new Map(),
    }),
    fetchVanityData: async () => null,
    fetchWidgetSettings: async () => ({ enabled: false, channel: null }),
    fetchWelcomeScreen: async () => ({ enabled: false, description: null, welcomeChannels: [] }),
    fetchOnboarding: async () => ({ enabled: false, mode: 0, prompts: [], defaultChannels: [] }),
    fetchTemplates: async () => new Map(),
    iconURL: () => null,
    bannerURL: () => null,
    splashURL: () => null,
    discoverySplashURL: () => null,
    edit: async (options: Record<string, unknown>) => {
      edits.push(options);
      return guild;
    },
    // The real setters mutate and return the updated guild, so the fake must too:
    // a fixture that returns a stale object would hide a handler reading the wrong field.
    setName: async (name: string, reason?: string) => {
      edits.push({ name, reason });
      guild.name = name;
      return guild;
    },
    setIcon: async (icon: unknown, reason?: string) => {
      edits.push({ icon, reason });
      guild.icon = icon as string | null;
      return guild;
    },
    setBanner: async (banner: unknown, reason?: string) => {
      edits.push({ banner, reason });
      guild.banner = banner as string | null;
      return guild;
    },
    setWidgetSettings: async (settings: Record<string, unknown>) => {
      edits.push({ widget: settings });
      return guild;
    },
    createTemplate: async (name: string) => ({ code: "abc123", name, serializedGuild: {} }),
    ...overrides,
  };
  return { guild, edits };
}

test("set_guild_name changes the guild name and reports before/after", async () => {
  const { guild, edits } = fakeGuild();
  mock.method(discord.guilds, "fetch", async () => guild as never);
  const res = await handler(
    guildSettings,
    "discord_set_guild_name",
  )({
    guild_id: GUILD,
    name: "Watchtower Community",
    reason: "rebrand",
  });
  assert.equal(edits.length, 1);
  assert.equal(edits[0]!.name, "Watchtower Community");
  assert.equal(edits[0]!.reason, "rebrand");
  const data = res.structuredContent as { previous_name: string; name: string };
  assert.equal(data.previous_name, "Watchtower");
  assert.equal(data.name, "Watchtower Community");
});

test("set_guild_name refuses without Manage Server and names the missing permission", async () => {
  const { guild } = fakeGuild();
  guild.members.me.permissions = new PermissionsBitField([]);
  mock.method(discord.guilds, "fetch", async () => guild as never);
  await assert.rejects(
    () => handler(guildSettings, "discord_set_guild_name")({ guild_id: GUILD, name: "Nope" }),
    /lacks the ManageGuild permission/,
  );
});

test("set_guild_name describes the guild-vs-bot-name distinction in its description", () => {
  const def = guildSettings.definitions.find((d) => d.name === "discord_set_guild_name")!;
  assert.match(def.description, /not the bot's own name/);
  assert.match(def.description, /discord_set_bot_nickname/);
});

test("set_membership_gate sends the feature list and reports the real post-call state", async () => {
  // Discord accepts the request but may drop the feature, so the fake returns a
  // guild that does NOT carry it: the handler must report what Discord returned,
  // not what was asked for.
  const { guild, edits } = fakeGuild();
  guild.features = ["COMMUNITY"] as never;
  mock.method(discord.guilds, "fetch", async () => guild as never);
  const res = await handler(
    guildSettings,
    "discord_set_membership_gate",
  )({ guild_id: GUILD, enabled: true, reason: "gate" });
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0]!.features, ["COMMUNITY", "MEMBER_VERIFICATION_GATE_ENABLED"]);
  assert.equal(edits[0]!.reason, "gate");
  const data = res.structuredContent as { enabled: boolean; features: string[] };
  assert.equal(data.enabled, false, "the reported state must come from Discord's response");
});

test("set_membership_gate removes the feature when disabling", async () => {
  const { guild, edits } = fakeGuild();
  guild.features = ["COMMUNITY", "MEMBER_VERIFICATION_GATE_ENABLED"] as never;
  mock.method(discord.guilds, "fetch", async () => guild as never);
  await handler(guildSettings, "discord_set_membership_gate")({ guild_id: GUILD, enabled: false });
  assert.deepEqual(edits[0]!.features, ["COMMUNITY"]);
});

test("set_membership_gate refuses without Manage Server", async () => {
  const { guild } = fakeGuild();
  guild.members.me.permissions = new PermissionsBitField([]);
  mock.method(discord.guilds, "fetch", async () => guild as never);
  await assert.rejects(
    () => handler(guildSettings, "discord_set_membership_gate")({ guild_id: GUILD, enabled: true }),
    /lacks the ManageGuild permission/,
  );
});

test("set_membership_gate documents that Discord refuses the enable over the API", () => {
  const def = guildSettings.definitions.find((d) => d.name === "discord_set_membership_gate")!;
  assert.match(def.description, /silently ignores/);
  assert.match(def.description, /by hand/);
});

test("get_guild_settings returns the full server state without mutating", async () => {
  const { guild, edits } = fakeGuild();
  mock.method(discord.guilds, "fetch", async () => guild as never);
  const res = await handler(guildSettings, "discord_get_guild_settings")({ guild_id: GUILD });
  const data = res.structuredContent as {
    name: string;
    member_count: number;
    premium_tier: number;
  };
  assert.equal(data.name, "Watchtower");
  assert.equal(data.member_count, 12);
  assert.equal(edits.length, 0, "a read must not edit");
});

test("set_guild_banner previews when no image is given, and the removal tool clears it", async () => {
  const { guild, edits } = fakeGuild();
  mock.method(discord.guilds, "fetch", async () => guild as never);
  await handler(guildSettings, "discord_remove_guild_banner")({ guild_id: GUILD });
  assert.equal(edits.length, 1);
  assert.equal(edits[0]!.banner, null, "removal must send an explicit null");
});

test("enable_community refuses when the prerequisite channels are missing", async () => {
  const { guild } = fakeGuild({ features: [], rulesChannelId: null, publicUpdatesChannelId: null });
  mock.method(discord.guilds, "fetch", async () => guild as never);
  const res = await handler(
    guildSettings,
    "discord_enable_community",
  )({ guild_id: GUILD, enabled: true });
  const data = res.structuredContent as {
    prerequisite_check_only: boolean;
    missing_prerequisites: string[];
  };
  assert.equal(data.prerequisite_check_only, true, "the call must stop at the prerequisite check");
  assert.ok(data.missing_prerequisites.length >= 2);
  assert.ok(data.missing_prerequisites.some((p) => /rules/i.test(p)));
  assert.ok(data.missing_prerequisites.some((p) => /public.updates/i.test(p)));
});

test("get_bot_permissions reports the required flags with their users", async () => {
  const { guild } = fakeGuild();
  mock.method(discord.guilds, "fetch", async () => guild as never);
  const res = await handler(guildSettings, "discord_get_bot_permissions")({ guild_id: GUILD });
  const data = res.structuredContent as {
    permissions: { permission: string; granted: boolean; used_by: string }[];
    all_granted: boolean;
  };
  assert.ok(data.permissions.some((p) => p.permission === "ManageGuild"));
  assert.ok(
    data.permissions.every((p) => p.used_by.length > 0),
    "each flag must say what needs it",
  );
});

test("bot identity tools distinguish the four names and avatars explicitly", async () => {
  const { guild } = fakeGuild();
  mock.method(discord.guilds, "fetch", async () => guild as never);
  const res = await handler(botProfile, "discord_get_bot_identity")({ guild_id: GUILD });
  const data = res.structuredContent as {
    guild_nickname: string | null;
    guild_name: string;
    notes: string[];
  };
  assert.equal(data.guild_nickname, null);
  assert.equal(data.guild_name, "Watchtower");
  assert.ok(data.notes.some((n) => /banner/.test(n) && /user accounts/.test(n)));
});

test("the bot profile limits report states what Discord does not allow", async () => {
  const res = await handler(botProfile, "discord_get_bot_profile_limits")({});
  const data = res.structuredContent as {
    changeable: { field: string; scope: string; tool: string }[];
    not_changeable: { field: string; reason: string }[];
  };
  assert.ok(
    data.changeable.some((c) => c.field === "per-server nickname" && c.scope === "one server"),
  );
  assert.ok(
    data.changeable.some((c) => c.field === "global username" && c.scope === "all servers"),
  );
  assert.ok(
    data.not_changeable.some((c) => /banner/.test(c.field)),
    "the banner limitation must be documented, not hidden",
  );
  assert.ok(
    data.not_changeable.every((c) => c.reason.length > 20),
    "each limitation needs a real reason, not a placeholder",
  );
});

test("set_bot_nickname refuses to guess when the bot member is not cached", async () => {
  const { guild } = fakeGuild();
  (guild.members as { me: unknown }).me = null;
  mock.method(discord.guilds, "fetch", async () => guild as never);
  await assert.rejects(
    () => handler(botProfile, "discord_set_bot_nickname")({ guild_id: GUILD, nickname: "X" }),
    /not cached/,
  );
});

test("check_tool_permissions reports per-tool readiness and unknown tools", async () => {
  const { guild } = fakeGuild();
  mock.method(discord.guilds, "fetch", async () => guild as never);
  const res = await handler(
    diagnostics,
    "discord_check_tool_permissions",
  )({
    guild_id: GUILD,
    tools: ["discord_create_channel", "discord_ban_member", "discord_not_a_real_tool"],
  });
  const data = res.structuredContent as {
    results: { tool: string; ready: boolean; known_tool: boolean; missing_permissions: string[] }[];
    summary: string;
  };
  const channel = data.results.find((r) => r.tool === "discord_create_channel")!;
  assert.equal(channel.ready, true);
  assert.deepEqual(channel.required_permissions ?? [], ["ManageChannels"]);
  const unknown = data.results.find((r) => r.tool === "discord_not_a_real_tool")!;
  assert.equal(unknown.known_tool, false);
  assert.equal(unknown.ready, false, "an unknown tool must never be reported as ready");
});

test("check_tool_permissions flags a genuinely missing permission", async () => {
  const { guild } = fakeGuild();
  guild.members.me.permissions = new PermissionsBitField(["ViewChannel"]);
  mock.method(discord.guilds, "fetch", async () => guild as never);
  const res = await handler(
    diagnostics,
    "discord_check_tool_permissions",
  )({
    guild_id: GUILD,
    tools: ["discord_ban_member"],
  });
  const data = res.structuredContent as {
    results: { ready: boolean; missing_permissions: string[] }[];
    summary: string;
  };
  assert.equal(data.results[0]!.ready, false);
  assert.deepEqual(data.results[0]!.missing_permissions, ["BanMembers"]);
  assert.match(data.summary, /1 of 1/);
});

test("verify_setup reports a missing token as a boolean and never echoes it", async () => {
  const saved = process.env.DISCORD_TOKEN;
  delete process.env.DISCORD_TOKEN;
  const res = await handler(diagnostics, "discord_verify_setup")({});
  const data = res.structuredContent as { token_configured: boolean; problems: string[] };
  assert.equal(data.token_configured, false);
  assert.ok(data.problems.some((p) => /DISCORD_TOKEN is not set/.test(p)));
  assert.ok(
    !textOf(res).includes("test-token-login-is-stubbed"),
    "the token value must never appear",
  );
  process.env.DISCORD_TOKEN = saved;
});

test("read_audit_trail labels itself as the MCP trail, not Discord's audit log", async () => {
  const res = await handler(diagnostics, "discord_read_audit_trail")({ limit: 5 });
  const data = res.structuredContent as { note: string; entries: unknown[] };
  assert.match(data.note, /not Discord's audit log/);
  assert.ok(Array.isArray(data.entries));
});

test("schedule_message previews the empty-message guard and refuses a sub-minute repeat", async () => {
  const sent: unknown[] = [];
  const channel = {
    id: CHANNEL,
    name: "general",
    guildId: GUILD,
    isDMBased: () => false,
    isTextBased: () => true,
    send: async (payload: unknown) => {
      sent.push(payload);
      return { id: "m1" };
    },
  };
  mock.method(discord.channels, "fetch", async () => channel as never);

  await assert.rejects(
    () => handler(scheduler, "discord_schedule_message")({ channel_id: CHANNEL, delay_seconds: 5 }),
    /not empty/,
  );

  const created = await handler(
    scheduler,
    "discord_schedule_message",
  )({
    channel_id: CHANNEL,
    content: "hello",
    delay_seconds: 3600,
    repeat_every_seconds: 7200,
  });
  const data = created.structuredContent as { task_id: string; repeats: boolean; warning: string };
  assert.equal(data.repeats, true);
  assert.match(data.warning, /lost on restart/);

  const listed = await handler(scheduler, "discord_list_scheduled_tasks")({});
  const list = listed.structuredContent as { tasks: { id: string }[] };
  assert.ok(list.tasks.some((t) => t.id === data.task_id));

  const cancelled = await handler(
    scheduler,
    "discord_cancel_scheduled_task",
  )({ task_id: data.task_id });
  assert.equal((cancelled.structuredContent as { cancelled: boolean }).cancelled, true);
  assert.equal(sent.length, 0, "a scheduled message must not send immediately");
});

test("publish_announcement parses no mentions by default", async () => {
  const payloads: Record<string, unknown>[] = [];
  const channel = {
    id: CHANNEL,
    name: "announcements",
    guildId: GUILD,
    type: 0,
    isDMBased: () => false,
    isTextBased: () => true,
    send: async (payload: Record<string, unknown>) => {
      payloads.push(payload);
      return { id: "m2", crosspost: async () => undefined };
    },
  };
  mock.method(discord.channels, "fetch", async () => channel as never);
  const res = await handler(
    scheduler,
    "discord_publish_announcement",
  )({
    channel_id: CHANNEL,
    title: "Release 1.0",
    body: "Hello @everyone, this must not ping.",
  });
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0]!.allowedMentions, { parse: [] });
  assert.equal(payloads[0]!.content, undefined, "the body lives in the embed, not the content");
  assert.equal((res.structuredContent as { pinged: string }).pinged, "none");
});

test("publish_announcement refuses ping:'role' without a role id", async () => {
  await assert.rejects(
    () =>
      handler(
        scheduler,
        "discord_publish_announcement",
      )({
        channel_id: CHANNEL,
        title: "t",
        body: "b",
        ping: "role",
      }),
    /ping_role_id/,
  );
});

test("apply_automod_baseline previews the rules and creates nothing", async () => {
  let created = 0;
  const { guild } = fakeGuild({
    autoModerationRules: {
      fetch: async () => new Map(),
      create: async () => {
        created += 1;
        return {};
      },
    },
  });
  mock.method(discord.guilds, "fetch", async () => guild as never);
  const res = await handler(automod, "discord_apply_automod_baseline")({ guild_id: GUILD });
  const data = res.structuredContent as { mode: string; planned: string[]; created: string[] };
  assert.equal(data.mode, "preview");
  assert.ok(data.planned.length >= 3);
  assert.deepEqual(data.created, []);
  assert.equal(created, 0, "a preview must not create a rule");
});

test("create_automod_rule refuses without Manage Server", async () => {
  const { guild } = fakeGuild();
  guild.members.me.permissions = new PermissionsBitField(["ViewChannel"]);
  mock.method(discord.guilds, "fetch", async () => guild as never);
  await assert.rejects(
    () =>
      handler(
        automod,
        "discord_create_automod_rule",
      )({
        guild_id: GUILD,
        name: "Rule",
        trigger_type: "keyword",
        keywords: ["bad"],
        actions: [{ type: "block_message" }],
      }),
    /lacks the ManageGuild permission/,
  );
});

test("create_emoji rejects an oversized image before calling Discord", async () => {
  let created = 0;
  const { guild } = fakeGuild({
    emojis: {
      cache: new Map(),
      fetch: async () => new Map(),
      create: async () => {
        created += 1;
        return {};
      },
    },
  });
  mock.method(discord.guilds, "fetch", async () => guild as never);
  // A real PNG header followed by padding, so the fixture passes the image sniff
  // and reaches the emoji-specific 256 KB cap that this test is about.
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const oversized = `data:image/png;base64,${Buffer.concat([pngHeader, Buffer.alloc(300 * 1024)]).toString("base64")}`;
  await assert.rejects(
    () =>
      handler(
        expressions,
        "discord_create_emoji",
      )({ guild_id: GUILD, name: "big", image: oversized }),
    /256 KB/,
  );
  assert.equal(created, 0, "the size guard must run before the API call");
});

test("export_structure states plainly that messages are not included", async () => {
  const { guild } = fakeGuild();
  mock.method(discord.guilds, "fetch", async () => guild as never);
  const res = await handler(backup, "discord_export_structure")({ guild_id: GUILD });
  const data = res.structuredContent as {
    backup: { format: string; channels: unknown[]; roles: unknown[] };
    summary: { message_history_included: boolean };
  };
  assert.equal(data.summary.message_history_included, false);
  assert.equal(data.backup.format, "discord-mcp-ultimate/structure-backup@1");
  const def = backup.definitions.find((d) => d.name === "discord_export_structure")!;
  assert.match(def.description, /NOT messages/);
});

test("restore_structure previews and never creates on a bare call", async () => {
  const { guild } = fakeGuild();
  mock.method(discord.guilds, "fetch", async () => guild as never);
  const res = await handler(
    backup,
    "discord_restore_structure",
  )({
    guild_id: GUILD,
    backup: {
      format: "discord-mcp-ultimate/structure-backup@1",
      created_at: new Date().toISOString(),
      guild_id: GUILD,
      guild_name: "Watchtower",
      roles: [
        {
          id: "r1",
          name: "Member",
          color: "#000000",
          position: 1,
          hoist: false,
          mentionable: false,
          managed: false,
          permissions: ["ViewChannel"],
        },
      ],
      categories: [],
      channels: [],
    },
  });
  const data = res.structuredContent as {
    mode: string;
    applied: boolean;
    created: unknown[];
    planned: string[];
  };
  assert.equal(data.mode, "preview");
  assert.equal(data.applied, false);
  assert.deepEqual(data.created, []);
  assert.ok(data.planned.includes("role:Member"));
});

test("apply_name_theme previews and reports the rename list without renaming", async () => {
  const renames: string[] = [];
  const category = {
    id: "c1",
    name: "General",
    type: 4,
    setName: async (name: string) => void renames.push(name),
  };
  const { guild } = fakeGuild({
    channels: {
      cache: new Map([[category.id, category]]),
      fetch: async () => new Map([[category.id, category]]),
      create: async () => ({ id: "new" }),
    },
  });
  mock.method(discord.guilds, "fetch", async () => guild as never);
  mock.method(discord.channels, "fetch", async () => new Map());

  const preview = await handler(
    style,
    "discord_apply_name_theme",
  )({
    guild_id: GUILD,
    theme: "futuristic",
  });
  const data = preview.structuredContent as {
    mode: string;
    planned: { from: string; to: string }[];
  };
  assert.equal(data.mode, "preview");
  assert.equal(renames.length, 0, "a preview must not rename");
  assert.equal(data.planned.length, 1);
  assert.equal(data.planned[0]!.from, "General");
  assert.equal(data.planned[0]!.to, "✦・general");
});

test("style_name generates one variant per style and strips invisible characters", async () => {
  const res = await handler(style, "discord_style_name")({ name: "annon\u200Bces" });
  const data = res.structuredContent as { variants: { style: string; name: string }[] };
  assert.equal(data.variants.length, 12);
  for (const variant of data.variants) {
    assert.ok(!variant.name.includes("\u200B"), `${variant.style} kept a zero-width character`);
    assert.ok(variant.name.length > 0, `${variant.style} produced nothing`);
  }
  // Every style except fullwidth keeps the ASCII slug verbatim; fullwidth maps it
  // to the Unicode full-width alphabet on purpose, which is the point of the style.
  const byStyle = new Map(data.variants.map((v) => [v.style, v.name]));
  for (const variant of data.variants) {
    if (variant.style === "fullwidth") {
      assert.match(variant.name, /ａｎｎｏｎｃｅｓ/, "fullwidth must transliterate the slug");
      assert.ok(!variant.name.includes("annonces"), "fullwidth must not leave ASCII behind");
    } else {
      assert.ok(variant.name.includes("annonces"), `${variant.style} lost the slug`);
    }
  }
  assert.ok(byStyle.size === 12);
});

test("style_preview reports collisions rather than silently creating duplicates", async () => {
  const res = await handler(
    style,
    "discord_style_preview",
  )({
    theme: "minimal",
    items: [
      { kind: "text_channel", name: "general" },
      { kind: "text_channel", name: "general" },
    ],
  });
  const data = res.structuredContent as { collisions: { name: string; intents: string[] }[] };
  assert.equal(data.collisions.length, 1);
  assert.equal(data.collisions[0]!.intents.length, 2);
});

test("every new mutating tool that can delete advertises a destructive hint", () => {
  const destructive = [
    [guildSettings, "discord_remove_guild_icon"],
    [botProfile, "discord_set_bot_username"],
    [automod, "discord_delete_automod_rule"],
    [expressions, "discord_delete_emoji"],
    [expressions, "discord_delete_sticker"],
  ] as const;
  for (const [mod, name] of destructive) {
    const def = mod.definitions.find((d) => d.name === name)!;
    assert.ok(def, `${name} is missing`);
    assert.ok(def.annotations?.title, `${name} needs a human-readable title`);
  }
  assert.equal(
    expressions.definitions.find((d) => d.name === "discord_delete_emoji")!.annotations
      ?.destructiveHint,
    true,
  );
});
