import { AuditLogEvent, EmbedBuilder, type Guild, type GuildBasedChannel } from "discord.js";

import type { GuildConfig, LogEvent } from "./guildConfig.js";
import { truncate } from "./features.js";

/**
 * Builds the embeds posted to a server's log channel.
 *
 * Every builder is pure: it takes the event's facts and returns an embed, and the
 * caller decides whether and where to send it. That keeps the format testable —
 * the wording, the colour and the field order are the parts an operator notices
 * and the parts a live gateway makes tedious to check.
 *
 * Attribution is looked up from Discord's audit log where it is available, because
 * "a message was deleted" is far less useful than "X deleted Y's message".
 */

export const LOG_COLOURS: Record<LogEvent, number> = {
  messageDelete: 0xed4245,
  messageEdit: 0xfee75c,
  memberJoin: 0x57f287,
  memberLeave: 0xed4245,
  memberBan: 0x992d22,
  memberUnban: 0x57f287,
  memberUpdate: 0x5865f2,
  roleCreate: 0x57f287,
  roleDelete: 0xed4245,
  roleUpdate: 0x5865f2,
  channelCreate: 0x57f287,
  channelDelete: 0xed4245,
  channelUpdate: 0x5865f2,
  voiceJoin: 0x57f287,
  voiceLeave: 0xed4245,
  inviteCreate: 0x5865f2,
  inviteDelete: 0xed4245,
};

export const LOG_TITLES: Record<LogEvent, string> = {
  messageDelete: "Message deleted",
  messageEdit: "Message edited",
  memberJoin: "Member joined",
  memberLeave: "Member left",
  memberBan: "Member banned",
  memberUnban: "Member unbanned",
  memberUpdate: "Member updated",
  roleCreate: "Role created",
  roleDelete: "Role deleted",
  roleUpdate: "Role updated",
  channelCreate: "Channel created",
  channelDelete: "Channel deleted",
  channelUpdate: "Channel updated",
  voiceJoin: "Joined voice",
  voiceLeave: "Left voice",
  inviteCreate: "Invite created",
  inviteDelete: "Invite deleted",
};

function base(event: LogEvent, title: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(LOG_COLOURS[event])
    .setTitle(LOG_TITLES[event] ?? title)
    .setTimestamp(new Date());
}

/** `#channel (id)` when the channel resolves, the bare id when it does not. */
function channelLabel(channel: GuildBasedChannel | { id: string; name?: string } | null): string {
  if (!channel) return "unknown channel";
  const name = "name" in channel && channel.name ? `#${channel.name}` : "";
  return name ? `${name} (\`${channel.id}\`)` : `\`${channel.id}\``;
}

export function messageDeleteEmbed(ctx: {
  authorId: string;
  authorTag: string;
  channel: { id: string; name?: string } | null;
  content: string;
  attachmentCount: number;
  /** Who deleted it, when the audit log names them. */
  executorId?: string;
}): EmbedBuilder {
  const embed = base("messageDelete", "Message deleted")
    .setDescription(
      ctx.content
        ? truncate(ctx.content, 4000)
        : "_No cached content (sent before the bot started)._",
    )
    .addFields(
      { name: "Author", value: `<@${ctx.authorId}> (${ctx.authorTag})`, inline: true },
      { name: "Channel", value: channelLabel(ctx.channel), inline: true },
    );
  if (ctx.attachmentCount > 0) {
    embed.addFields({ name: "Attachments", value: String(ctx.attachmentCount), inline: true });
  }
  if (ctx.executorId && ctx.executorId !== ctx.authorId) {
    embed.addFields({ name: "Deleted by", value: `<@${ctx.executorId}>`, inline: true });
  }
  return embed;
}

export function messageEditEmbed(ctx: {
  authorId: string;
  authorTag: string;
  channel: { id: string; name?: string } | null;
  before: string;
  after: string;
  jumpUrl: string;
}): EmbedBuilder {
  return base("messageEdit", "Message edited")
    .setDescription(`[Jump to message](${ctx.jumpUrl})`)
    .addFields(
      { name: "Author", value: `<@${ctx.authorId}> (${ctx.authorTag})`, inline: true },
      { name: "Channel", value: channelLabel(ctx.channel), inline: true },
      { name: "Before", value: truncate(ctx.before || "_empty_", 1024) },
      { name: "After", value: truncate(ctx.after || "_empty_", 1024) },
    );
}

export function memberJoinEmbed(ctx: {
  userId: string;
  userTag: string;
  accountCreated: Date;
  memberCount: number;
}): EmbedBuilder {
  return base("memberJoin", "Member joined")
    .setThumbnail(null)
    .setDescription(`<@${ctx.userId}> (${ctx.userTag})`)
    .addFields(
      {
        name: "Account created",
        value: `<t:${Math.floor(ctx.accountCreated.getTime() / 1000)}:R>`,
        inline: true,
      },
      { name: "Member count", value: String(ctx.memberCount), inline: true },
    );
}

export function memberLeaveEmbed(ctx: {
  userId: string;
  userTag: string;
  joinedAt: Date | null;
  roles: string[];
  memberCount: number;
}): EmbedBuilder {
  const embed = base("memberLeave", "Member left")
    .setDescription(`<@${ctx.userId}> (${ctx.userTag})`)
    .addFields({ name: "Member count", value: String(ctx.memberCount), inline: true });
  if (ctx.joinedAt) {
    embed.addFields({
      name: "Joined",
      value: `<t:${Math.floor(ctx.joinedAt.getTime() / 1000)}:R>`,
      inline: true,
    });
  }
  if (ctx.roles.length > 0) {
    embed.addFields({
      name: `Roles (${ctx.roles.length})`,
      value: truncate(ctx.roles.join(", "), 1024),
    });
  }
  return embed;
}

export function memberBanEmbed(ctx: {
  userId: string;
  userTag: string;
  moderatorId?: string;
  reason?: string;
}): EmbedBuilder {
  const embed = base("memberBan", "Member banned").setDescription(
    `<@${ctx.userId}> (${ctx.userTag})`,
  );
  if (ctx.moderatorId)
    embed.addFields({ name: "Moderator", value: `<@${ctx.moderatorId}>`, inline: true });
  if (ctx.reason) embed.addFields({ name: "Reason", value: truncate(ctx.reason, 1024) });
  return embed;
}

export function memberUnbanEmbed(ctx: {
  userId: string;
  userTag: string;
  moderatorId?: string;
}): EmbedBuilder {
  const embed = base("memberUnban", "Member unbanned").setDescription(
    `<@${ctx.userId}> (${ctx.userTag})`,
  );
  if (ctx.moderatorId)
    embed.addFields({ name: "Moderator", value: `<@${ctx.moderatorId}>`, inline: true });
  return embed;
}

export function memberUpdateEmbed(ctx: {
  userId: string;
  userTag: string;
  added: string[];
  removed: string[];
  nicknameFrom: string | null;
  nicknameTo: string | null;
}): EmbedBuilder {
  const embed = base("memberUpdate", "Member updated").setDescription(
    `<@${ctx.userId}> (${ctx.userTag})`,
  );
  if (ctx.nicknameFrom !== ctx.nicknameTo) {
    embed.addFields({
      name: "Nickname",
      value: `${ctx.nicknameFrom ? truncate(ctx.nicknameFrom, 200) : "_none_"} → ${ctx.nicknameTo ? truncate(ctx.nicknameTo, 200) : "_none_"}`,
    });
  }
  if (ctx.added.length)
    embed.addFields({
      name: "Roles added",
      value: truncate(ctx.added.map((r) => `<@&${r}>`).join(" "), 1024),
    });
  if (ctx.removed.length)
    embed.addFields({
      name: "Roles removed",
      value: truncate(ctx.removed.map((r) => `<@&${r}>`).join(" "), 1024),
    });
  return embed;
}

export function roleChangeEmbed(
  event: "roleCreate" | "roleDelete" | "roleUpdate",
  ctx: { roleId: string; name: string; changes?: string[]; executorId?: string },
): EmbedBuilder {
  const embed = base(event, "Role changed")
    .setDescription(`<@&${ctx.roleId}> \`${ctx.roleId}\``)
    .addFields({
      name: "Name",
      value: truncate(ctx.name, 256),
      inline: true,
    });
  if (ctx.changes?.length)
    embed.addFields({ name: "Changes", value: truncate(ctx.changes.join("\n"), 1024) });
  if (ctx.executorId) embed.addFields({ name: "By", value: `<@${ctx.executorId}>`, inline: true });
  return embed;
}

export function channelChangeEmbed(
  event: "channelCreate" | "channelDelete" | "channelUpdate",
  ctx: { channelId: string; name: string; type?: string; changes?: string[]; executorId?: string },
): EmbedBuilder {
  const embed = base(event, "Channel changed")
    .setDescription(`<#${ctx.channelId}> \`${ctx.channelId}\``)
    .addFields({ name: "Name", value: truncate(ctx.name, 256), inline: true });
  if (ctx.type) embed.addFields({ name: "Type", value: ctx.type, inline: true });
  if (ctx.changes?.length)
    embed.addFields({ name: "Changes", value: truncate(ctx.changes.join("\n"), 1024) });
  if (ctx.executorId) embed.addFields({ name: "By", value: `<@${ctx.executorId}>`, inline: true });
  return embed;
}

export function voiceEmbed(
  event: "voiceJoin" | "voiceLeave",
  ctx: { userId: string; channelId: string; channelName: string },
): EmbedBuilder {
  return base(event, "Voice").setDescription(
    `<@${ctx.userId}> ${event === "voiceJoin" ? "joined" : "left"} **${ctx.channelName}** (\`${ctx.channelId}\`)`,
  );
}

export function inviteEmbed(
  event: "inviteCreate" | "inviteDelete",
  ctx: {
    code: string;
    inviterId?: string | null;
    uses?: number;
    maxUses?: number;
    channelId?: string | null;
  },
): EmbedBuilder {
  const embed = base(event, "Invite").addFields({
    name: "Code",
    value: `\`${ctx.code}\``,
    inline: true,
  });
  if (ctx.inviterId)
    embed.addFields({ name: "Inviter", value: `<@${ctx.inviterId}>`, inline: true });
  if (ctx.channelId)
    embed.addFields({ name: "Channel", value: `<#${ctx.channelId}>`, inline: true });
  if (ctx.uses !== undefined) {
    embed.addFields({
      name: "Uses",
      value: `${ctx.uses}${ctx.maxUses ? ` / ${ctx.maxUses}` : ""}`,
      inline: true,
    });
  }
  return embed;
}

/**
 * Finds who performed an action, from the guild's audit log.
 *
 * Returns undefined rather than throwing when the bot lacks View Audit Log, which
 * is the common case and should not break logging of the event itself.
 */
export async function auditExecutor(
  guild: Guild,
  type: AuditLogEvent,
  targetId: string,
  windowMs = 10_000,
): Promise<{ executorId: string; reason?: string } | undefined> {
  if (!guild.members.me?.permissions.has("ViewAuditLog")) return undefined;
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    const cutoff = Date.now() - windowMs;
    const entry = logs.entries.find((e) => e.targetId === targetId && e.createdTimestamp > cutoff);
    if (!entry) return undefined;
    return { executorId: entry.executorId ?? "", reason: entry.reason ?? undefined };
  } catch {
    // Rate-limited or permission revoked mid-flight: the event still gets logged.
    return undefined;
  }
}

/** True when the guild wants this event logged and has a channel to log it to. */
export function shouldLog(cfg: GuildConfig, event: LogEvent): boolean {
  return (
    cfg.logging.enabled && cfg.logging.channelId !== null && cfg.logging.events.includes(event)
  );
}
