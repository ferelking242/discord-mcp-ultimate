import { z } from "zod";

import { JsonDocument } from "./store.js";

/**
 * Per-guild settings for every bot feature.
 *
 * One document holds them all rather than one file per feature, because the
 * several sections are edited at once and an operator wants a single thing to back up.
 * Every section carries `enabled`, so a feature is off until someone turns it on:
 * a bot that starts welcoming, logging and levelling the moment it joins a server
 * is a bot people kick.
 *
 * The schema is the contract between three consumers that never see each other:
 * the event handlers and the slash commands. Parsing on
 * read is what keeps a hand-edited file from crashing a handler at 3am.
 */

const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord snowflake");

const welcomeSchema = z.object({
  enabled: z.boolean().default(false),
  channelId: snowflake.nullable().default(null),
  message: z
    .string()
    .max(2000)
    .default("Welcome to the server, {user}! You are member #{memberCount}.")
    .describe("Supports {user}, {username}, {server}, {memberCount}."),
  dmEnabled: z.boolean().default(false),
  dmMessage: z
    .string()
    .max(2000)
    .default("Welcome to {server}!")
    .describe("Supports the same tokens."),
  goodbyeEnabled: z.boolean().default(false),
  goodbyeMessage: z.string().max(2000).default("{username} has left the server."),
});

const autoroleSchema = z.object({
  enabled: z.boolean().default(false),
  /** Granted on join, in order. Bots are skipped, since a role for a bot is noise. */
  roleIds: z.array(snowflake).max(10).default([]),
  /** Roles the bot must NOT grant to accounts younger than this, when set. */
  minAccountAgeDays: z.int().min(0).max(365).default(0),
});

const loggingSchema = z.object({
  enabled: z.boolean().default(false),
  channelId: snowflake.nullable().default(null),
  events: z
    .array(
      z.enum([
        "messageDelete",
        "messageEdit",
        "memberJoin",
        "memberLeave",
        "memberBan",
        "memberUnban",
        "memberUpdate",
        "roleCreate",
        "roleDelete",
        "roleUpdate",
        "channelCreate",
        "channelDelete",
        "channelUpdate",
        "voiceJoin",
        "voiceLeave",
        "inviteCreate",
        "inviteDelete",
      ]),
    )
    .default(["messageDelete", "memberJoin", "memberLeave", "memberBan"]),
});

const levelsSchema = z.object({
  enabled: z.boolean().default(false),
  xpMin: z.int().min(1).max(100).default(15),
  xpMax: z.int().min(1).max(1000).default(25),
  cooldownSeconds: z.int().min(0).max(3600).default(60),
  announce: z.boolean().default(true),
  announceChannelId: snowflake.nullable().default(null),
  levelUpMessage: z.string().max(500).default("GG {user}, you reached level {level}!"),
  /** Roles handed out at a level. A role below the bot's highest, or it cannot be granted. */
  roleRewards: z
    .array(z.object({ level: z.int().min(1).max(1000), roleId: snowflake }))
    .max(25)
    .default([]),
  /** Channels and roles that earn no XP. */
  ignoredChannelIds: z.array(snowflake).default([]),
  ignoredRoleIds: z.array(snowflake).default([]),
});

const ticketsSchema = z.object({
  enabled: z.boolean().default(false),
  panelChannelId: snowflake.nullable().default(null),
  panelMessageId: snowflake.nullable().default(null),
  /** Category new ticket channels are created under. */
  categoryId: snowflake.nullable().default(null),
  supportRoleIds: z.array(snowflake).default([]),
  /** Where a closed transcript is posted. */
  transcriptChannelId: snowflake.nullable().default(null),
  /** One open ticket per member, or unlimited. */
  onePerMember: z.boolean().default(true),
  openMessage: z
    .string()
    .max(2000)
    .default("Thanks for reaching out — a member of the team will be with you shortly."),
  maxOpenPerGuild: z.int().min(1).max(200).default(50),
});

const giveawaysSchema = z.object({
  enabled: z.boolean().default(false),
  /** Members who must already have this role to enter, when set. */
  requiredRoleId: snowflake.nullable().default(null),
  /** Minimum account age in days to enter. */
  minAccountAgeDays: z.int().min(0).max(365).default(0),
  defaultDurationMinutes: z.int().min(1).max(10080).default(1440),
  maxWinners: z.int().min(1).max(100).default(10),
});

const starboardSchema = z.object({
  enabled: z.boolean().default(false),
  channelId: snowflake.nullable().default(null),
  emoji: z.string().min(1).default("⭐"),
  threshold: z.int().min(1).max(100).default(3),
  /** Channels never mirrored. */
  ignoredChannelIds: z.array(snowflake).default([]),
});

const tempVoiceSchema = z.object({
  enabled: z.boolean().default(false),
  /** Joining any of these channels creates a personal one. */
  hubChannelIds: z.array(snowflake).default([]),
  categoryId: snowflake.nullable().default(null),
  nameTemplate: z.string().max(100).default("🔊 {username}'s channel"),
  userLimit: z.int().min(0).max(99).default(0),
  /** Delete the personal channel this many seconds after it empties. */
  emptyTimeoutSeconds: z.int().min(5).max(600).default(30),
});

const autoresponderSchema = z.object({
  enabled: z.boolean().default(false),
  rules: z
    .array(
      z.object({
        id: z.string(),
        trigger: z.string().min(1).max(100),
        match: z.enum(["contains", "exact", "startsWith"]).default("contains"),
        reply: z.string().min(1).max(2000),
        /** A member holding this role bypasses the reply. */
        ignoreRoleId: snowflake.nullable().default(null),
        /** Reply once per member per cooldown, so a phrase cannot spam. */
        cooldownSeconds: z.int().min(0).max(86400).default(300),
      }),
    )
    .max(50)
    .default([]),
});

const moderationSchema = z.object({
  enabled: z.boolean().default(false),
  /** DM the member when an action is taken against them. */
  dmOnAction: z.boolean().default(true),
  /** Default timeout in minutes for `/timeout` with no duration given. */
  defaultTimeoutMinutes: z.int().min(1).max(40320).default(10),
  /** Roles removed on mute and restored on unmute, when a mute role is not used. */
  logChannelId: snowflake.nullable().default(null),
});

export const guildConfigSchema = z.object({
  guildId: snowflake,
  welcome: welcomeSchema.default(() => welcomeSchema.parse({})),
  autorole: autoroleSchema.default(() => autoroleSchema.parse({})),
  logging: loggingSchema.default(() => loggingSchema.parse({})),
  levels: levelsSchema.default(() => levelsSchema.parse({})),
  tickets: ticketsSchema.default(() => ticketsSchema.parse({})),
  giveaways: giveawaysSchema.default(() => giveawaysSchema.parse({})),
  starboard: starboardSchema.default(() => starboardSchema.parse({})),
  tempVoice: tempVoiceSchema.default(() => tempVoiceSchema.parse({})),
  autoresponder: autoresponderSchema.default(() => autoresponderSchema.parse({})),
  moderation: moderationSchema.default(() => moderationSchema.parse({})),
});

export type GuildConfig = z.infer<typeof guildConfigSchema>;
export type LogEvent = z.infer<typeof loggingSchema>["events"][number];
export type AutoresponderRule = z.infer<typeof autoresponderSchema>["rules"][number];

const fileSchema = z.object({
  version: z.literal(1),
  guilds: z.record(z.string(), guildConfigSchema),
});

type FileShape = z.infer<typeof fileSchema>;

/** A config with every default applied, for a guild nobody has configured. */
export function defaultGuildConfig(guildId: string): GuildConfig {
  return guildConfigSchema.parse({ guildId });
}

/**
 * Reads and writes per-guild settings.
 *
 * `get` never returns undefined: an unconfigured guild gets a fully-defaulted
 * config, so a handler can read `cfg.levels.enabled` without a null check and
 * without the caller needing to know whether the guild was ever configured.
 */
export class GuildConfigStore {
  private readonly doc: JsonDocument<FileShape>;

  constructor(file: string) {
    this.doc = new JsonDocument<FileShape>({
      file,
      create: () => ({ version: 1, guilds: {} }),
      normalize: (raw) => fileSchema.parse(raw),
    });
  }

  async load(): Promise<void> {
    await this.doc.load();
  }

  get(guildId: string): GuildConfig {
    const stored = this.doc.get().guilds[guildId];
    return stored ?? defaultGuildConfig(guildId);
  }

  /** True when the guild has saved settings, as opposed to running on defaults. */
  isConfigured(guildId: string): boolean {
    return this.doc.get().guilds[guildId] !== undefined;
  }

  guildIds(): string[] {
    return Object.keys(this.doc.get().guilds);
  }

  /**
   * Merges a partial config into a guild's settings and persists.
   *
   * A deep merge rather than a replace: a caller sends one section at a time,
   * and a replace would silently wipe the sections it did not mention. The merged
   * result is re-parsed, so an invalid patch fails here rather than at the next read.
   */
  async patch(guildId: string, patch: DeepPartial<GuildConfig>): Promise<GuildConfig> {
    const current = this.get(guildId);
    const merged = guildConfigSchema.parse(deepMerge(current, patch) as Record<string, unknown>);
    await this.doc.update((doc) => ({
      version: 1,
      guilds: { ...doc.guilds, [guildId]: merged },
    }));
    return merged;
  }

  /** Replaces a guild's settings wholesale. Used by the config import command. */
  async set(guildId: string, config: GuildConfig): Promise<GuildConfig> {
    const parsed = guildConfigSchema.parse(config);
    await this.doc.update((doc) => ({
      version: 1,
      guilds: { ...doc.guilds, [guildId]: parsed },
    }));
    return parsed;
  }

  /** Drops a guild's settings, returning it to defaults. */
  async reset(guildId: string): Promise<void> {
    await this.doc.update((doc) => {
      const guilds = { ...doc.guilds };
      delete guilds[guildId];
      return { version: 1, guilds };
    });
  }

  reloadIfChanged(): Promise<boolean> {
    return this.doc.reloadIfChanged();
  }

  watch(onChange?: (guilds: string[]) => void): () => void {
    return this.doc.watch((data) => onChange?.(Object.keys(data.guilds)));
  }
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/**
 * Merges `patch` into `base`, recursing into plain objects.
 *
 * Arrays are replaced, never merged element-wise: a caller that sends a shorter
 * `roleIds` means "these roles", and a union would make removing one impossible.
 */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(base) || typeof base !== "object") return patch as T;
  if (typeof patch !== "object" || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    out[key] = deepMerge((base as Record<string, unknown>)[key], value as never);
  }
  return out as T;
}
