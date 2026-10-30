import { ChannelType, type Guild, type GuildMember } from "discord.js";

import { discord } from "../client.js";
import type {
  DashboardBackend,
  GuildDetail,
  GuildSummary,
  MemberSummary,
  ModerationRequest,
} from "../dashboard/api.js";
import { canGrantRole, parseDuration, truncate } from "./features.js";
import type { Logger } from "./handlers.js";
import { MAX_TIMEOUT_MS } from "./features.js";
import type { BotServices } from "./services.js";

/**
 * The dashboard's view of Discord.
 *
 * Every discord.js call the dashboard makes lives here. The routes in
 * `src/dashboard/api.ts` work against the interface, so they can be tested without
 * a gateway, and every permission check sits next to the call it guards.
 *
 * The checks are the point. A dashboard button is easy to click and impossible to
 * undo, so each action re-derives what Discord will allow — the bot's highest role,
 * the member's relative position, the operator's own rights — instead of trusting
 * that the UI only offered valid options.
 */

export class DiscordBackend implements DashboardBackend {
  private readonly startedAt = Date.now();

  constructor(
    readonly services: BotServices,
    private readonly logger: Logger,
  ) {}

  botInfo(): { tag: string; id: string; uptimeSeconds: number; ping: number } {
    return {
      tag: discord.user?.tag ?? "not connected",
      id: discord.user?.id ?? "",
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      ping: Math.round(discord.ws.ping),
    };
  }

  async listGuilds(): Promise<GuildSummary[]> {
    const guilds = [...discord.guilds.cache.values()];
    return Promise.all(
      guilds.map(async (guild) => ({
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL({ size: 64 }),
        // `memberCount` is only exact with the Guild Members intent; `cache.size`
        // is a floor without it, and the dashboard says so rather than lying.
        memberCount: guild.memberCount,
        ownerId: guild.ownerId,
        botPresent: guild.members.me !== null,
      })),
    );
  }

  async getGuild(guildId: string): Promise<GuildDetail | null> {
    const guild = await this.fetchGuild(guildId);
    if (!guild) return null;

    const channels = [...guild.channels.cache.values()].map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channelTypeName(channel.type),
      parentId: channel.parentId,
    }));

    const roles = [...guild.roles.cache.values()]
      .map((role) => ({
        id: role.id,
        name: role.name,
        position: role.position,
        managed: role.managed,
        color: role.color,
      }))
      .sort((a, b) => b.position - a.position);

    return {
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL({ size: 128 }),
      memberCount: guild.memberCount,
      ownerId: guild.ownerId,
      botPresent: guild.members.me !== null,
      channels,
      roles,
      botHighestRolePosition: guild.members.me?.roles.highest.position ?? -1,
    };
  }

  async listMembers(guildId: string, limit: number): Promise<MemberSummary[]> {
    const guild = await this.fetchGuild(guildId);
    if (!guild) return [];
    // A fetch rather than the cache: the dashboard is usually opened shortly after
    // the bot starts, when the member cache is still filling in.
    const members = await guild.members.fetch({ limit });
    return [...members.values()].map((member) => toMemberSummary(member));
  }

  /**
   * Applies a moderation action and records a case.
   *
   * Order matters: the Discord call runs first, and a case is written only if it
   * succeeded. A case file that records a ban that never happened is worse than no
   * case at all, because it is what a moderator later relies on.
   */
  async applyModeration(
    request: ModerationRequest,
  ): Promise<{ caseNumber: number; summary: string }> {
    const guild = await this.fetchGuild(request.guildId);
    if (!guild) throw new Error(`the bot is not in guild ${request.guildId}`);

    const me = guild.members.me;
    if (!me) throw new Error("the bot's own member record is unavailable");

    const moderator = await guild.members.fetch(request.moderatorId).catch(() => null);
    const target = await guild.members.fetch(request.userId).catch(() => null);
    const botMember = await guild.members.fetch(me.id).catch(() => me);

    const reason = truncate(request.reason || "no reason given", 500);
    let summary: string;

    switch (request.action) {
      case "warn":
      case "note": {
        if (!target) throw new Error("that member is not in this server");
        summary =
          request.action === "warn"
            ? `Warned ${target.user.tag}`
            : `Note added on ${target.user.tag}`;
        if (request.action === "warn") {
          await dmIfPossible(target, guild.name, `You were warned in **${guild.name}**: ${reason}`);
        }
        break;
      }
      case "timeout": {
        if (!target) throw new Error("that member is not in this server");
        assertModeratable(botMember, target, "timeout");
        const durationMs = Math.min(
          request.durationMs ??
            this.services.guildConfig.get(guild.id).moderation.defaultTimeoutMinutes * 60_000,
          MAX_TIMEOUT_MS,
        );
        if (durationMs <= 0) throw new Error("timeout duration must be positive");
        await target.timeout(durationMs, reason);
        summary = `Timed out ${target.user.tag} for ${formatDuration(durationMs)}`;
        await dmIfPossible(
          target,
          guild.name,
          `You were timed out in **${guild.name}** for ${formatDuration(durationMs)}: ${reason}`,
        );
        break;
      }
      case "untimeout": {
        if (!target) throw new Error("that member is not in this server");
        if (!target.isCommunicationDisabled()) throw new Error("that member is not timed out");
        await target.timeout(null, reason);
        summary = `Removed the timeout on ${target.user.tag}`;
        break;
      }
      case "kick": {
        if (!target) throw new Error("that member is not in this server");
        assertModeratable(botMember, target, "kick");
        if (!botMember.permissions.has("KickMembers"))
          throw new Error("the bot lacks Kick Members");
        await target.kick(reason);
        summary = `Kicked ${target.user.tag}`;
        break;
      }
      case "ban": {
        if (!botMember.permissions.has("BanMembers")) throw new Error("the bot lacks Ban Members");
        if (target) assertModeratable(botMember, target, "ban");
        // A ban works on a user id, so it is the one action that does not need the
        // member to still be present.
        await guild.bans.create(request.userId, { reason });
        summary = `Banned ${target?.user.tag ?? request.userId}`;
        break;
      }
      case "unban": {
        if (!botMember.permissions.has("BanMembers")) throw new Error("the bot lacks Ban Members");
        const ban = await guild.bans.fetch(request.userId).catch(() => null);
        if (!ban) throw new Error("that user is not banned");
        await guild.bans.remove(request.userId, reason);
        summary = `Unbanned ${ban.user.tag}`;
        break;
      }
      default:
        throw new Error(`unsupported action: ${String(request.action)}`);
    }

    const caseNumber = this.services.moderation.nextNumber(guild.id);
    await this.services.moderation.add({
      number: caseNumber,
      guildId: guild.id,
      type: request.action,
      targetId: request.userId,
      targetTag: target?.user.tag ?? request.userId,
      moderatorId: request.moderatorId,
      moderatorTag: moderator?.user.tag ?? request.moderatorId,
      reason,
      durationMs: request.action === "timeout" ? (request.durationMs ?? null) : null,
      createdAt: new Date().toISOString(),
      active: request.action === "timeout" || request.action === "ban",
    });

    this.logger.info("moderation applied", {
      guildId: guild.id,
      action: request.action,
      caseNumber,
    });
    return { caseNumber, summary };
  }

  private async fetchGuild(guildId: string): Promise<Guild | null> {
    return (
      discord.guilds.cache.get(guildId) ?? (await discord.guilds.fetch(guildId).catch(() => null))
    );
  }
}

function toMemberSummary(member: GuildMember): MemberSummary {
  return {
    id: member.id,
    tag: member.user.tag,
    displayName: member.displayName,
    joinedAt: member.joinedAt?.toISOString() ?? null,
    isBot: member.user.bot,
    roleIds: [...member.roles.cache.keys()],
  };
}

/**
 * Rejects an action Discord would refuse, with a reason an operator can act on.
 *
 * The role-hierarchy rule is the one people get wrong: a bot can only act on a
 * member whose highest role is below its own, and the server owner is exempt from
 * everything. Reporting that plainly beats a bare 50013.
 */
function assertModeratable(bot: GuildMember, target: GuildMember, action: string): void {
  if (target.id === bot.id) throw new Error(`the bot cannot ${action} itself`);
  if (target.id === target.guild.ownerId) {
    throw new Error(`the server owner cannot be ${action}ed by the bot`);
  }
  if (target.roles.highest.position >= bot.roles.highest.position) {
    throw new Error(
      `cannot ${action} ${target.user.tag}: their highest role is at or above the bot's. Move the bot's role higher.`,
    );
  }
}

async function dmIfPossible(
  member: GuildMember,
  guildName: string,
  message: string,
): Promise<void> {
  if (!guildName) return;
  await member.send(message).catch(() => {
    // Closed DMs are the normal case, not a failure of the action itself.
  });
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function channelTypeName(type: ChannelType): string {
  const names: Partial<Record<ChannelType, string>> = {
    [ChannelType.GuildText]: "text",
    [ChannelType.GuildVoice]: "voice",
    [ChannelType.GuildCategory]: "category",
    [ChannelType.GuildAnnouncement]: "announcement",
    [ChannelType.GuildStageVoice]: "stage",
    [ChannelType.GuildForum]: "forum",
    [ChannelType.GuildMedia]: "media",
  };
  return names[type] ?? "other";
}

export { parseDuration, canGrantRole };
