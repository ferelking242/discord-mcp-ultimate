import type { Guild, GuildMember, Role } from "discord.js";

import type { AutoresponderRule, GuildConfig } from "./guildConfig.js";

/**
 * Pure helpers shared by the feature handlers.
 *
 * Nothing here touches discord.js beyond reading types, and nothing reads the
 * environment or the clock unless it is passed in. That is deliberate: the parts
 * that are easy to get subtly wrong — template expansion, role grantability,
 * matching — are exactly the parts worth testing without a gateway connection.
 */

/**
 * Expands the placeholders the bot's messages understand.
 *
 * Unknown placeholders are left as written rather than blanked. A message reading
 * `{usernam}` is an obvious typo the author can fix; a silently empty string looks
 * like the bot is broken.
 */
export function expandTemplate(
  template: string,
  vars: {
    user?: GuildMember | null;
    username?: string;
    server?: string;
    memberCount?: number;
    level?: number;
    channel?: string;
  },
): string {
  const map: Record<string, string> = {
    user: vars.user ? `<@${vars.user.id}>` : "",
    username: vars.username ?? vars.user?.user?.username ?? "",
    server: vars.server ?? "",
    memberCount: vars.memberCount !== undefined ? String(vars.memberCount) : "",
    level: vars.level !== undefined ? String(vars.level) : "",
    channel: vars.channel ?? "",
  };
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(map, name) ? map[name] : whole,
  );
}

/**
 * True when the bot can actually grant this role.
 *
 * Discord rejects `roles.add` for a managed role, for a role at or above the bot's
 * highest, or when the bot lacks Manage Roles. Checking first turns a silent
 * failure on an ordinary member's join into a startup-time warning.
 */
export function canGrantRole(
  bot: GuildMember,
  role: Role,
): { ok: true } | { ok: false; reason: string } {
  if (role.managed)
    return { ok: false, reason: `role "${role.name}" is managed by an integration` };
  if (!bot.permissions.has("ManageRoles"))
    return { ok: false, reason: "the bot lacks Manage Roles" };
  if (role.position >= bot.roles.highest.position) {
    return { ok: false, reason: `role "${role.name}" sits at or above the bot's highest role` };
  }
  return { ok: true };
}

/** Account age in whole days. Used by the autorole and giveaway age gates. */
export function accountAgeDays(createdAt: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000);
}

/**
 * Whether an autorole should be granted to this member.
 *
 * The age gate exists because a fresh account is the cheapest way to raid a
 * server, and the join-time window is when the damage is done.
 */
export function shouldGrantAutoroles(
  cfg: GuildConfig,
  member: Pick<GuildMember, "user">,
  now: Date = new Date(),
): { grant: boolean; reason?: string } {
  if (!cfg.autorole.enabled) return { grant: false, reason: "autorole disabled" };
  if (member.user.bot) return { grant: false, reason: "member is a bot" };
  if (cfg.autorole.roleIds.length === 0) return { grant: false, reason: "no roles configured" };
  if (cfg.autorole.minAccountAgeDays > 0) {
    const age = accountAgeDays(member.user.createdAt, now);
    if (age < cfg.autorole.minAccountAgeDays) {
      return {
        grant: false,
        reason: `account is ${age} day(s) old, under the ${cfg.autorole.minAccountAgeDays}-day minimum`,
      };
    }
  }
  return { grant: true };
}

/** Random XP for one message, inclusive on both ends. */
export function rollXp(cfg: GuildConfig, rand: () => number = Math.random): number {
  const min = Math.min(cfg.levels.xpMin, cfg.levels.xpMax);
  const max = Math.max(cfg.levels.xpMin, cfg.levels.xpMax);
  return min + Math.floor(rand() * (max - min + 1));
}

/**
 * Total XP needed to reach `level` from zero.
 *
 * The MEE6 curve, kept because members recognise it: each level costs 5 more than
 * the last, so early levels come quickly and later ones are a real commitment.
 */
export function xpForLevel(level: number): number {
  if (level <= 0) return 0;
  return 5 * level * level + 50 * level + 100;
}

/** The level a member with `xp` total XP has reached. */
export function levelForXp(xp: number): number {
  let level = 0;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

/** Progress towards the next level, for a rank card or a `/rank` reply. */
export function levelProgress(xp: number): {
  level: number;
  intoLevel: number;
  needed: number;
  percent: number;
} {
  const level = levelForXp(xp);
  const floor = xpForLevel(level);
  const ceiling = xpForLevel(level + 1);
  const intoLevel = xp - floor;
  const needed = ceiling - floor;
  return {
    level,
    intoLevel,
    needed,
    percent: needed === 0 ? 100 : Math.floor((intoLevel / needed) * 100),
  };
}

/**
 * Decides whether a message earns XP.
 *
 * Every exclusion here is a way to farm XP without talking: bots do not earn, a
 * blocked channel or role earns nothing, and the cooldown stops a member from
 * posting a word per second.
 */
export function earnsXp(
  cfg: GuildConfig,
  ctx: { isBot: boolean; channelId: string; roleIds: readonly string[] },
): { earns: boolean; reason?: string } {
  if (!cfg.levels.enabled) return { earns: false, reason: "levels disabled" };
  if (ctx.isBot) return { earns: false, reason: "author is a bot" };
  if (cfg.levels.ignoredChannelIds.includes(ctx.channelId)) {
    return { earns: false, reason: "channel is excluded" };
  }
  if (ctx.roleIds.some((id) => cfg.levels.ignoredRoleIds.includes(id))) {
    return { earns: false, reason: "member holds an excluded role" };
  }
  return { earns: true };
}

/** Role rewards the member has newly qualified for at `level`. */
export function roleRewardsFor(
  cfg: GuildConfig,
  level: number,
  alreadyHas: readonly string[],
): string[] {
  return cfg.levels.roleRewards
    .filter((r) => r.level <= level && !alreadyHas.includes(r.roleId))
    .map((r) => r.roleId);
}

/**
 * Matches a message against the autoresponder rules, first match winning.
 *
 * `ignoreRoleId` is checked per rule rather than globally, so a support role can
 * still trigger a rule that an ordinary member also triggers.
 */
export function matchAutoresponder(
  cfg: GuildConfig,
  content: string,
  memberRoleIds: readonly string[],
): { rule?: AutoresponderRule; reason?: string } {
  if (!cfg.autoresponder.enabled) return { rule: undefined, reason: "autoresponder disabled" };
  for (const rule of cfg.autoresponder.rules) {
    if (rule.ignoreRoleId && memberRoleIds.includes(rule.ignoreRoleId)) continue;
    const text = content.trim();
    const trigger = rule.trigger.toLowerCase();
    const haystack = text.toLowerCase();
    const hit =
      rule.match === "exact"
        ? haystack === trigger
        : rule.match === "startsWith"
          ? haystack.startsWith(trigger)
          : haystack.includes(trigger);
    if (hit) return { rule };
  }
  return { rule: undefined, reason: "no rule matched" };
}

/**
 * Splits a member-supplied duration into milliseconds.
 *
 * Accepts `10m`, `2h`, `3d`, `1w`, or a bare number of minutes. Returns null on
 * anything else rather than guessing: a timeout of the wrong length is worse than
 * a refused command.
 */
export function parseDuration(input: string): number | null {
  const m = input.trim().match(/^(\d+)\s*(s|m|h|d|w)?$/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (m[2] ?? "m").toLowerCase();
  const unitMs: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return value * unitMs[unit];
}

/** Discord caps a timeout at 28 days. */
export const MAX_TIMEOUT_MS = 28 * 86_400_000;

/** Truncates for an embed field or a log line, marking that it was cut. */
export function truncate(text: string, max = 1024): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** The guild's display name, with a fallback for the unavailable case. */
export function guildName(guild: Guild): string {
  return guild.name ?? "the server";
}
