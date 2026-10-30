import {
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type DMChannel,
  type GuildBan,
  type GuildMember,
  type Interaction,
  type Invite,
  type Message,
  type MessageReaction,
  type NonThreadGuildBasedChannel,
  type PartialGuildMember,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type Role,
  type User,
  type VoiceState,
} from "discord.js";

import type { BotConfig } from "./config.js";
import {
  accountAgeDays,
  canGrantRole,
  earnsXp,
  expandTemplate,
  guildName,
  levelProgress,
  matchAutoresponder,
  roleRewardsFor,
  rollXp,
  shouldGrantAutoroles,
  truncate,
} from "./features.js";
import type { GuildConfig, LogEvent } from "./guildConfig.js";
import type { Logger } from "./handlers.js";
import {
  auditExecutor,
  channelChangeEmbed,
  inviteEmbed,
  memberBanEmbed,
  memberJoinEmbed,
  memberLeaveEmbed,
  memberUnbanEmbed,
  memberUpdateEmbed,
  messageDeleteEmbed,
  messageEditEmbed,
  roleChangeEmbed,
  shouldLog,
  voiceEmbed,
} from "./logging.js";
import { SlidingWindowLimiter } from "./rateLimit.js";
import type { BotServices } from "./services.js";

/**
 * The gateway event wiring for every bot feature.
 *
 * Design rules that hold throughout:
 *
 * - **A handler never throws into discord.js.** Each entry point catches its own
 *   errors and logs them. An unhandled rejection in a gateway event handler takes
 *   down the process, and one bad message should not disconnect the bot.
 * - **The allow-list is checked first.** `DISCORD_ALLOWED_GUILDS` is an operator
 *   saying "only these servers", so every handler returns before doing work for a
 *   guild outside it, rather than relying on each feature to remember.
 * - **Discord calls are attempted, not assumed.** A missing permission is the
 *   normal case on a server the bot just joined, so the failure is logged at debug
 *   level and the feature carries on.
 */

export interface FeatureHandlerOptions {
  client: Client;
  services: BotServices;
  config: BotConfig;
  logger: Logger;
}

/** Fields the handlers need that only exist on a full member, not a partial. */
function isPartialMember(member: GuildMember | PartialGuildMember): member is PartialGuildMember {
  return member.partial;
}

export class FeatureHandlers {
  private readonly services: BotServices;
  private readonly config: BotConfig;
  private readonly logger: Logger;
  /** Caps how often one member can make the bot speak, per guild. */
  private readonly autoresponderLimiter = new SlidingWindowLimiter(5, 20_000);

  constructor(opts: FeatureHandlerOptions) {
    this.services = opts.services;
    this.config = opts.config;
    this.logger = opts.logger;
  }

  private allowed(guildId: string | null): boolean {
    if (!guildId) return false;
    return this.config.allowedGuilds.length === 0 || this.config.allowedGuilds.includes(guildId);
  }

  private cfg(guildId: string): GuildConfig {
    return this.services.guildConfig.get(guildId);
  }

  /** Wraps a handler so a failure is logged and never reaches discord.js. */
  private guard<A extends unknown[]>(name: string, fn: (...args: A) => Promise<void>) {
    return (...args: A): void => {
      void fn(...args).catch((err: unknown) => {
        this.logger.error(`${name} handler failed`, { error: (err as Error).message });
      });
    };
  }

  /** Attaches every listener. Called once, after the client is ready. */
  attach(client: Client): void {
    this.clientRef = client;
    client.on(
      "messageCreate",
      this.guard("messageCreate", (m: Message) => this.onMessage(m)),
    );
    client.on(
      "messageDelete",
      this.guard("messageDelete", (m: Message | PartialMessage) => this.onMessageDelete(m)),
    );
    client.on(
      "messageUpdate",
      this.guard(
        "messageUpdate",
        (before: Message | PartialMessage, after: Message | PartialMessage) =>
          this.onMessageUpdate(before, after),
      ),
    );
    client.on(
      "guildMemberAdd",
      this.guard("guildMemberAdd", (m: GuildMember) => this.onMemberAdd(m)),
    );
    client.on(
      "guildMemberRemove",
      this.guard("guildMemberRemove", (m: GuildMember | PartialGuildMember) =>
        this.onMemberRemove(m),
      ),
    );
    client.on(
      "guildMemberUpdate",
      this.guard(
        "guildMemberUpdate",
        (before: GuildMember | PartialGuildMember, after: GuildMember) =>
          this.onMemberUpdate(before, after),
      ),
    );
    client.on(
      "guildBanAdd",
      this.guard("guildBanAdd", (ban) => this.onBanAdd(ban)),
    );
    client.on(
      "guildBanRemove",
      this.guard("guildBanRemove", (ban) => this.onBanRemove(ban)),
    );
    client.on(
      "messageReactionAdd",
      this.guard(
        "messageReactionAdd",
        (r: MessageReaction | PartialMessageReaction, u: User | PartialUser) =>
          this.onReactionAdd(r, u),
      ),
    );
    client.on(
      "voiceStateUpdate",
      this.guard("voiceStateUpdate", (o: VoiceState, n: VoiceState) => this.onVoice(o, n)),
    );
    client.on(
      "roleCreate",
      this.guard("roleCreate", (role) => this.onRoleChange("roleCreate", role)),
    );
    client.on(
      "roleDelete",
      this.guard("roleDelete", (role) => this.onRoleChange("roleDelete", role)),
    );
    client.on(
      "channelDelete",
      this.guard("channelDelete", (channel) => this.onChannelChange("channelDelete", channel)),
    );
    client.on(
      "inviteCreate",
      this.guard("inviteCreate", (invite) => this.onInvite("inviteCreate", invite)),
    );
    client.on(
      "inviteDelete",
      this.guard("inviteDelete", (invite) => this.onInvite("inviteDelete", invite)),
    );
    client.on(
      "interactionCreate",
      this.guard("interactionCreate", (i: Interaction) => this.onInteraction(i)),
    );
  }

  // ── Logging helper ──────────────────────────────────────────────────────────

  /**
   * Posts an embed to the guild's log channel when that event is enabled.
   *
   * Silently returns when logging is off, the channel is unset, or the channel is
   * gone — a deleted log channel must not throw on every subsequent event.
   */
  private async log(guildId: string, event: LogEvent, embed: EmbedBuilder): Promise<void> {
    const cfg = this.cfg(guildId);
    if (!shouldLog(cfg, event) || !cfg.logging.channelId) return;
    if (!this.clientRef) return;
    const target = await this.clientRef.channels.fetch(cfg.logging.channelId).catch(() => null);
    // A deleted or unreadable log channel must not throw on every later event.
    if (!target || !target.isTextBased() || !("send" in target)) return;
    await target.send({ embeds: [embed] }).catch((err: unknown) => {
      this.logger.warn("could not write to the log channel", {
        guildId,
        error: (err as Error).message,
      });
    });
  }

  /** Set by {@link attach}. Kept as a field so `log` needs no client parameter. */
  private clientRef: Client | null = null;

  // ── Messages: levels and autoresponder ─────────────────────────────────────

  private async onMessage(message: Message): Promise<void> {
    if (!message.guildId || !this.allowed(message.guildId)) return;
    if (message.author.bot || message.system) return;
    const member = message.member;
    if (!member) return;
    const cfg = this.cfg(message.guildId);

    await this.grantXp(message, member, cfg);
    await this.maybeAutoRespond(message, member, cfg);
  }

  private async grantXp(message: Message, member: GuildMember, cfg: GuildConfig): Promise<void> {
    const verdict = earnsXp(cfg, {
      isBot: message.author.bot,
      channelId: message.channelId,
      roleIds: [...member.roles.cache.keys()],
    });
    if (!verdict.earns) return;

    const record = this.services.levels.for(message.guildId!, member.id);
    const now = Date.now();
    // The cooldown is per member, not per channel: otherwise posting in five
    // channels at once would multiply the gain.
    if (now - record.lastXpAt < cfg.levels.cooldownSeconds * 1000) return;

    const gained = rollXp(cfg);
    const xp = record.xp + gained;
    const level = levelProgress(xp).level;
    const leveledUp = level > record.level;

    const next = {
      guildId: message.guildId!,
      userId: member.id,
      xp,
      level,
      messages: record.messages + 1,
      lastXpAt: now,
      updatedAt: new Date(now).toISOString(),
    };
    if (record.messages === 0 && record.xp === 0) await this.services.levels.add(next);
    else
      await this.services.levels.replace(
        (r) => r.guildId === message.guildId && r.userId === member.id,
        next,
      );

    if (!leveledUp) return;

    for (const roleId of roleRewardsFor(cfg, level, [...member.roles.cache.keys()])) {
      const role = await message.guild?.roles.fetch(roleId).catch(() => null);
      const me = message.guild?.members.me;
      if (!role || !me) continue;
      const grantable = canGrantRole(me, role);
      if (!grantable.ok) {
        this.logger.warn("level role not granted", {
          guildId: message.guildId,
          roleId,
          reason: grantable.reason,
        });
        continue;
      }
      await member.roles.add(role, `Level ${level} reward`).catch(() => null);
    }

    if (!cfg.levels.announce) return;
    const channelId = cfg.levels.announceChannelId ?? message.channelId;
    const target = await message.client.channels.fetch(channelId).catch(() => null);
    if (!target?.isTextBased() || !("send" in target)) return;
    await target
      .send(
        expandTemplate(cfg.levels.levelUpMessage, {
          user: member,
          level,
          server: guildName(message.guild!),
        }),
      )
      .catch(() => null);
  }

  private async maybeAutoRespond(
    message: Message,
    member: GuildMember,
    cfg: GuildConfig,
  ): Promise<void> {
    const { rule } = matchAutoresponder(cfg, message.content, [...member.roles.cache.keys()]);
    if (!rule) return;
    if (!this.autoresponderLimiter.allow(`${message.guildId}:${member.id}`)) return;

    const allowed = await this.services.cooldowns.allow(
      message.guildId!,
      member.id,
      rule.id,
      rule.cooldownSeconds * 1000,
    );
    if (!allowed) return;

    await message
      .reply({
        content: rule.reply,
        // A reply that pings whoever the rule mentions is how a welcome message
        // becomes a mass ping, so mentions in a rule are rendered, never parsed.
        allowedMentions: { parse: [], repliedUser: false },
      })
      .catch(() => null);
  }

  private async onMessageDelete(message: Message | PartialMessage): Promise<void> {
    const guildId = message.guildId;
    if (!guildId || !this.allowed(guildId)) return;
    const cfg = this.cfg(guildId);
    if (!shouldLog(cfg, "messageDelete")) return;
    if (message.author?.bot) return;

    const executor = await auditExecutor(
      message.guild!,
      AuditLogEvent.MessageDelete,
      message.author?.id ?? "",
    );
    await this.log(
      guildId,
      "messageDelete",
      messageDeleteEmbed({
        authorId: message.author?.id ?? "unknown",
        authorTag: message.author?.tag ?? "unknown",
        channel: message.channel
          ? {
              id: message.channel.id,
              name: "name" in message.channel ? (message.channel.name ?? undefined) : undefined,
            }
          : null,
        content: message.content ?? "",
        attachmentCount: message.attachments?.size ?? 0,
        executorId: executor?.executorId,
      }),
    );
  }

  private async onMessageUpdate(
    before: Message | PartialMessage,
    after: Message | PartialMessage,
  ): Promise<void> {
    const guildId = after.guildId;
    if (!guildId || !this.allowed(guildId)) return;
    if (after.author?.bot) return;
    // A partial `before` means the message was not cached, so there is no diff to
    // report. Logging "changed from nothing to something" would be noise.
    if (before.partial || after.partial) return;
    if (before.content === after.content) return;

    await this.log(
      guildId,
      "messageEdit",
      messageEditEmbed({
        authorId: after.author.id,
        authorTag: after.author.tag,
        channel: after.channel
          ? {
              id: after.channel.id,
              name: "name" in after.channel ? (after.channel.name ?? undefined) : undefined,
            }
          : null,
        before: before.content ?? "",
        after: after.content ?? "",
        jumpUrl: after.url,
      }),
    );
  }

  // ── Members ────────────────────────────────────────────────────────────────

  private async onMemberAdd(member: GuildMember): Promise<void> {
    const guildId = member.guild.id;
    if (!this.allowed(guildId)) return;
    const cfg = this.cfg(guildId);

    await this.applyAutoroles(member, cfg);
    await this.sendWelcome(member, cfg);
    await this.log(
      guildId,
      "memberJoin",
      memberJoinEmbed({
        userId: member.id,
        userTag: member.user.tag,
        accountCreated: member.user.createdAt,
        memberCount: member.guild.memberCount,
      }),
    );
  }

  private async applyAutoroles(member: GuildMember, cfg: GuildConfig): Promise<void> {
    const verdict = shouldGrantAutoroles(cfg, member);
    if (!verdict.grant) return;
    const me = member.guild.members.me;
    if (!me) return;

    for (const roleId of cfg.autorole.roleIds) {
      const role = await member.guild.roles.fetch(roleId).catch(() => null);
      if (!role) {
        this.logger.warn("autorole missing", { guildId: member.guild.id, roleId });
        continue;
      }
      const grantable = canGrantRole(me, role);
      if (!grantable.ok) {
        this.logger.warn("autorole not granted", {
          guildId: member.guild.id,
          roleId,
          reason: grantable.reason,
        });
        continue;
      }
      await member.roles.add(role, "Autorole on join").catch(() => null);
    }
  }

  private async sendWelcome(member: GuildMember, cfg: GuildConfig): Promise<void> {
    const vars = {
      user: member,
      username: member.user.username,
      server: member.guild.name,
      memberCount: member.guild.memberCount,
    };
    if (cfg.welcome.enabled && cfg.welcome.channelId) {
      const channel = await member.guild.channels.fetch(cfg.welcome.channelId).catch(() => null);
      if (channel?.isTextBased() && "send" in channel) {
        await channel
          .send({
            content: expandTemplate(cfg.welcome.message, vars),
            allowedMentions: { users: [member.id], parse: [] },
          })
          .catch(() => null);
      }
    }
    if (cfg.welcome.dmEnabled) {
      await member.send(expandTemplate(cfg.welcome.dmMessage, vars)).catch(() => null);
    }
  }

  private async onMemberRemove(member: GuildMember | PartialGuildMember): Promise<void> {
    const guildId = member.guild.id;
    if (!this.allowed(guildId)) return;
    const cfg = this.cfg(guildId);

    if (cfg.welcome.goodbyeEnabled && cfg.welcome.channelId) {
      const channel = await member.guild.channels.fetch(cfg.welcome.channelId).catch(() => null);
      if (channel?.isTextBased() && "send" in channel) {
        await channel
          .send({
            content: expandTemplate(cfg.welcome.goodbyeMessage, {
              username: member.user.username,
              server: member.guild.name,
              memberCount: member.guild.memberCount,
            }),
            allowedMentions: { parse: [] },
          })
          .catch(() => null);
      }
    }

    await this.log(
      guildId,
      "memberLeave",
      memberLeaveEmbed({
        userId: member.id,
        userTag: member.user.tag,
        joinedAt: member.joinedAt,
        roles: isPartialMember(member)
          ? []
          : [...member.roles.cache.values()].map((r) => `<@&${r.id}>`),
        memberCount: member.guild.memberCount,
      }),
    );
  }

  private async onMemberUpdate(
    before: GuildMember | PartialGuildMember,
    after: GuildMember,
  ): Promise<void> {
    const guildId = after.guild.id;
    if (!this.allowed(guildId)) return;
    if (isPartialMember(before)) return;

    const added = after.roles.cache.filter((r) => !before.roles.cache.has(r.id));
    const removed = before.roles.cache.filter((r) => !after.roles.cache.has(r.id));
    if (added.size === 0 && removed.size === 0 && before.nickname === after.nickname) return;

    await this.log(
      guildId,
      "memberUpdate",
      memberUpdateEmbed({
        userId: after.id,
        userTag: after.user.tag,
        added: [...added.keys()],
        removed: [...removed.keys()],
        nicknameFrom: before.nickname,
        nicknameTo: after.nickname,
      }),
    );
  }

  private async onBanAdd(ban: GuildBan): Promise<void> {
    const guildId = ban.guild.id;
    if (!this.allowed(guildId)) return;
    const executor = await auditExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    await this.log(
      guildId,
      "memberBan",
      memberBanEmbed({
        userId: ban.user.id,
        userTag: ban.user.tag,
        moderatorId: executor?.executorId,
        reason: executor?.reason ?? ban.reason ?? undefined,
      }),
    );
  }

  private async onBanRemove(ban: GuildBan): Promise<void> {
    const guildId = ban.guild.id;
    if (!this.allowed(guildId)) return;
    const executor = await auditExecutor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    await this.log(
      guildId,
      "memberUnban",
      memberUnbanEmbed({
        userId: ban.user.id,
        userTag: ban.user.tag,
        moderatorId: executor?.executorId,
      }),
    );
  }

  // ── Roles, channels, invites, voice ────────────────────────────────────────

  private async onRoleChange(event: "roleCreate" | "roleDelete", role: Role): Promise<void> {
    const guildId = role.guild.id;
    if (!this.allowed(guildId)) return;
    await this.log(guildId, event, roleChangeEmbed(event, { roleId: role.id, name: role.name }));
  }

  private async onChannelChange(
    event: "channelCreate" | "channelDelete",
    channel: NonThreadGuildBasedChannel | DMChannel,
  ): Promise<void> {
    // A DM channel has no guild, and the bot has no logs for one.
    if (!("guild" in channel) || !channel.guild) return;
    const guildId = channel.guild.id;
    if (!this.allowed(guildId)) return;
    await this.log(
      guildId,
      event,
      channelChangeEmbed(event, {
        channelId: channel.id,
        name: "name" in channel && channel.name ? channel.name : "unnamed",
        type: channelTypeName(channel.type),
      }),
    );
  }

  private async onInvite(event: "inviteCreate" | "inviteDelete", invite: Invite): Promise<void> {
    // `guild` is an InviteGuild on a fetch, which is not a full Guild; only its id
    // is needed, and only a partial one is available for a deleted invite.
    const guildId = invite.guild?.id;
    if (!guildId) return;
    if (!this.allowed(guildId)) return;
    await this.log(
      guildId,
      event,
      inviteEmbed(event, {
        code: invite.code,
        inviterId: invite.inviterId,
        uses: invite.uses ?? undefined,
        maxUses: invite.maxUses ?? undefined,
        channelId: invite.channelId,
      }),
    );
  }

  /**
   * Voice: logging plus the temporary-channel lifecycle.
   *
   * The hub check happens on join, and the cleanup on leave. Both read the same
   * store, so a channel created by a previous run is still cleaned up after a
   * restart rather than being orphaned.
   */
  private async onVoice(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const guildId = newState.guild.id;
    if (!this.allowed(guildId)) return;
    const cfg = this.cfg(guildId);

    if (newState.channelId && newState.channelId !== oldState.channelId) {
      await this.log(
        guildId,
        "voiceJoin",
        voiceEmbed("voiceJoin", {
          userId: newState.id,
          channelId: newState.channelId,
          channelName: newState.channel?.name ?? "unknown",
        }),
      );
      if (cfg.tempVoice.enabled && cfg.tempVoice.hubChannelIds.includes(newState.channelId)) {
        await this.createTempChannel(newState, cfg);
      }
    }

    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      await this.log(
        guildId,
        "voiceLeave",
        voiceEmbed("voiceLeave", {
          userId: oldState.id,
          channelId: oldState.channelId,
          channelName: oldState.channel?.name ?? "unknown",
        }),
      );
      if (cfg.tempVoice.enabled) await this.cleanupTempChannel(oldState.channelId, cfg);
    }
  }

  private async createTempChannel(state: VoiceState, cfg: GuildConfig): Promise<void> {
    const guild = state.guild;
    const member = state.member;
    if (!member) return;
    const channel = await guild.channels
      .create({
        name: truncate(
          expandTemplate(cfg.tempVoice.nameTemplate, { username: member.user.username }),
          100,
        ),
        type: ChannelType.GuildVoice,
        parent: cfg.tempVoice.categoryId ?? undefined,
        userLimit: cfg.tempVoice.userLimit || undefined,
        reason: `Temporary channel for ${member.user.tag}`,
      })
      .catch((err: unknown) => {
        this.logger.warn("could not create a temporary voice channel", {
          guildId: guild.id,
          error: (err as Error).message,
        });
        return null;
      });
    if (!channel) return;

    await this.services.tempVoice.add({
      guildId: guild.id,
      channelId: channel.id,
      ownerId: member.id,
      createdAt: new Date().toISOString(),
    });
    // Move the member in. Without this they stay in the hub and the new channel
    // sits empty until it is cleaned up a few seconds later.
    await member.voice.setChannel(channel).catch(() => null);
    this.logger.info("temporary voice channel created", {
      guildId: guild.id,
      channelId: channel.id,
    });
  }

  private async cleanupTempChannel(channelId: string, cfg: GuildConfig): Promise<void> {
    const tracked = this.services.tempVoice.byChannel(channelId);
    if (!tracked) return;
    const client = this.clientRef;
    if (!client) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isVoiceBased()) {
      await this.services.tempVoice.remove((c) => c.channelId === channelId);
      return;
    }
    // The grace period is what makes the feature usable: people hop out to grab a
    // link and come back, and a channel that vanishes immediately is a bug report.
    setTimeout(() => {
      void (async () => {
        const fresh = await client.channels.fetch(channelId).catch(() => null);
        if (!fresh || !fresh.isVoiceBased()) {
          await this.services.tempVoice.remove((c) => c.channelId === channelId);
          return;
        }
        if (fresh.members.size > 0) return;
        await fresh.delete("Temporary channel empty").catch(() => null);
        await this.services.tempVoice.remove((c) => c.channelId === channelId);
        this.logger.info("temporary voice channel removed", { channelId });
      })();
    }, cfg.tempVoice.emptyTimeoutSeconds * 1000).unref?.();
  }

  // ── Starboard ──────────────────────────────────────────────────────────────

  /**
   * Mirrors a message into the starboard once it passes the threshold.
   *
   * The count is read from the source message rather than incremented locally: a
   * member can un-react, and a counter that only goes up would never notice.
   */
  private async onReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    const guildId = reaction.message.guildId;
    if (!guildId || !this.allowed(guildId)) return;
    if (user.bot) return;
    const cfg = this.cfg(guildId);
    if (!cfg.starboard.enabled || !cfg.starboard.channelId) return;
    if (cfg.starboard.ignoredChannelIds.includes(reaction.message.channelId)) return;

    const reactionName = reaction.emoji.name ?? "";
    if (reactionName !== cfg.starboard.emoji) return;

    const message = await reaction.message.fetch().catch(() => null);
    if (!message || message.author.bot) return;
    const count = message.reactions.cache.get(cfg.starboard.emoji)?.count ?? 0;
    // The bot's own reaction counts in Discord's total but not as a star.
    const stars = Math.max(0, count - 1);
    if (stars < cfg.starboard.threshold) return;

    const existing = this.services.starboard.bySource(message.id);
    if (existing) {
      await this.services.starboard.setStars(message.id, stars);
      // Edit the stored message rather than re-posting: a starboard entry that
      // gains a duplicate every time it gains a star is unusable.
      const target = await message.client.channels
        .fetch(
          existing.starboardMessageId.startsWith("0")
            ? cfg.starboard.channelId
            : cfg.starboard.channelId,
        )
        .catch(() => null);
      if (target && target.isTextBased() && !target.isDMBased() && "messages" in target) {
        const posted = await target.messages.fetch(existing.starboardMessageId).catch(() => null);
        if (posted && posted.author.id === message.client.user?.id) {
          await posted.edit({ content: `⭐ **${stars}**` }).catch(() => null);
        }
      }
      return;
    }

    const target = await message.client.channels.fetch(cfg.starboard.channelId).catch(() => null);
    if (!target?.isTextBased() || !("send" in target)) return;
    const embed = new EmbedBuilder()
      .setColor(0xffc107)
      .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
      .setDescription(truncate(message.content || "_No text content._", 4000))
      .addFields({ name: "Source", value: `[Jump to message](${message.url})` })
      .setTimestamp(message.createdAt);
    if (message.attachments.size > 0) {
      const image = message.attachments.find((a) => a.contentType?.startsWith("image/"));
      if (image) embed.setImage(image.url);
    }
    const posted = await target
      .send({ content: `⭐ **${stars}** <#${message.channelId}>`, embeds: [embed] })
      .catch(() => null);
    if (!posted) return;
    await this.services.starboard.add({
      guildId,
      sourceChannelId: message.channelId,
      sourceMessageId: message.id,
      starboardMessageId: posted.id,
      authorId: message.author.id,
      starCount: stars,
      postedAt: new Date().toISOString(),
    });
  }

  // ── Interactions: ticket panel and giveaway entry ──────────────────────────

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.guildId || !this.allowed(interaction.guildId)) return;
    if (!interaction.isButton()) return;
    const [namespace, action] = interaction.customId.split(":");

    // The third field is the ticket number, which the store already knows; it is
    // carried in the id so a moderator can read it off the button in the UI.
    if (namespace === "ticket") return this.onTicketButton(interaction, action);
    if (namespace === "giveaway") return this.onGiveawayButton(interaction, action);
  }

  private async onTicketButton(
    interaction: import("discord.js").ButtonInteraction,
    action: string,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const cfg = this.cfg(guildId);
    if (!cfg.tickets.enabled) {
      await interaction.reply({
        content: "Les tickets ne sont pas activés sur ce serveur.",
        ephemeral: true,
      });
      return;
    }

    if (action === "open") {
      await interaction.deferReply({ ephemeral: true });
      const guild = interaction.guild!;
      const existing = this.services.tickets.openFor(guildId, interaction.user.id);
      if (cfg.tickets.onePerMember && existing.length > 0) {
        await interaction.editReply({
          content: `Vous avez déjà un ticket ouvert : <#${existing[0].channelId}>`,
        });
        return;
      }
      const open = this.services.tickets.open(guildId);
      if (open.length >= cfg.tickets.maxOpenPerGuild) {
        await interaction.editReply({
          content: "Trop de tickets sont ouverts en ce moment. Réessayez plus tard.",
        });
        return;
      }

      const number = this.services.tickets.nextNumber(guildId);
      const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        },
      ];
      const me = guild.members.me;
      for (const roleId of cfg.tickets.supportRoleIds) {
        if (me && me.roles.highest.position <= (guild.roles.cache.get(roleId)?.position ?? -1)) {
          this.logger.warn("ticket support role is above the bot; skipping its overwrite", {
            guildId,
            roleId,
          });
          continue;
        }
        overwrites.push({
          id: roleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages,
          ],
        });
      }

      const channel = await guild.channels
        .create({
          name: `ticket-${String(number).padStart(4, "0")}`,
          type: ChannelType.GuildText,
          parent: cfg.tickets.categoryId ?? undefined,
          topic: `Ticket #${number} — ${interaction.user.tag}`,
          permissionOverwrites: overwrites,
          reason: `Ticket #${number} opened by ${interaction.user.tag}`,
        })
        .catch(async (err: unknown) => {
          this.logger.error("could not create a ticket channel", {
            guildId,
            error: (err as Error).message,
          });
          await interaction.editReply({
            content: "Le salon du ticket n'a pas pu être créé. Vérifiez les permissions du bot.",
          });
          return null;
        });
      if (!channel) return;

      await this.services.tickets.add({
        number,
        guildId,
        channelId: channel.id,
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        subject: "",
        status: "open",
        claimedBy: null,
        createdAt: new Date().toISOString(),
        closedAt: null,
        closedBy: null,
      });

      const mentions = cfg.tickets.supportRoleIds.map((id) => `<@&${id}>`).join(" ");
      await channel
        .send({
          content: `${interaction.user} ${mentions}`.trim(),
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle(`Ticket #${number}`)
              .setDescription(cfg.tickets.openMessage)
              .addFields({ name: "Ouvert par", value: interaction.user.tag, inline: true })
              .setTimestamp(),
          ],
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 3, label: "Fermer", customId: `ticket:close:${number}` },
                { type: 2, style: 2, label: "Réclamer", customId: `ticket:claim:${number}` },
              ],
            },
          ],
        })
        .catch(() => null);

      await interaction.editReply({ content: `Ticket ouvert : ${channel}` });
      return;
    }

    if (action === "claim") {
      const ticket = this.services.tickets.byChannel(interaction.channelId);
      if (!ticket) {
        await interaction.reply({
          content: "Ce salon n'est pas un ticket suivi.",
          ephemeral: true,
        });
        return;
      }
      const isSupport =
        cfg.tickets.supportRoleIds.length === 0 ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ||
        cfg.tickets.supportRoleIds.some(
          (id) =>
            interaction.member?.roles &&
            "cache" in interaction.member.roles &&
            interaction.member.roles.cache.has(id),
        );
      if (!isSupport) {
        await interaction.reply({ content: "Réservé à l'équipe support.", ephemeral: true });
        return;
      }
      await this.services.tickets.replace((t) => t.channelId === interaction.channelId, {
        ...ticket,
        claimedBy: interaction.user.id,
      });
      await interaction.reply({ content: `Ticket réclamé par ${interaction.user}.` });
      return;
    }

    if (action === "close") {
      const ticket = this.services.tickets.byChannel(interaction.channelId);
      if (!ticket) {
        await interaction.reply({
          content: "Ce salon n'est pas un ticket suivi.",
          ephemeral: true,
        });
        return;
      }
      const isSupport =
        cfg.tickets.supportRoleIds.length === 0 ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ||
        cfg.tickets.supportRoleIds.some(
          (id) =>
            interaction.member?.roles &&
            "cache" in interaction.member.roles &&
            interaction.member.roles.cache.has(id),
        );
      if (interaction.user.id !== ticket.userId && !isSupport) {
        await interaction.reply({
          content: "Seul l'auteur du ticket ou l'équipe support peut le fermer.",
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({ content: "Fermeture du ticket…" });

      const channel = interaction.channel;
      if (channel?.isTextBased() && "messages" in channel) {
        const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        if (messages && cfg.tickets.transcriptChannelId) {
          const transcript = [...messages.values()]
            .reverse()
            .map((m) => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content}`)
            .join("\n");
          const target = await interaction.client.channels
            .fetch(cfg.tickets.transcriptChannelId)
            .catch(() => null);
          if (target?.isTextBased() && "send" in target) {
            await target
              .send({
                embeds: [
                  new EmbedBuilder()
                    .setColor(0x5865f2)
                    .setTitle(`Ticket #${ticket.number} fermé`)
                    .addFields(
                      { name: "Ouvert par", value: ticket.userTag, inline: true },
                      { name: "Fermé par", value: interaction.user.tag, inline: true },
                    ),
                ],
                files: [
                  {
                    attachment: Buffer.from(transcript || "(aucun message)", "utf8"),
                    name: `ticket-${ticket.number}.txt`,
                  },
                ],
              })
              .catch(() => null);
          }
        }
      }

      await this.services.tickets.replace((t) => t.channelId === interaction.channelId, {
        ...ticket,
        status: "closed",
        closedAt: new Date().toISOString(),
        closedBy: interaction.user.id,
      });

      // Discord cannot undo a channel deletion, so the transcript is posted first
      // and the deletion is the last thing that happens.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await interaction.channel
        ?.delete(`Ticket #${ticket.number} closed by ${interaction.user.tag}`)
        .catch(() => null);
      return;
    }

    await interaction.reply({ content: "Action inconnue.", ephemeral: true });
  }

  private async onGiveawayButton(
    interaction: import("discord.js").ButtonInteraction,
    action: string,
  ): Promise<void> {
    if (action !== "enter") {
      await interaction.reply({ content: "Action inconnue.", ephemeral: true });
      return;
    }
    const giveaway = this.services.giveaways.byMessage(interaction.message.id);
    if (!giveaway) {
      await interaction.reply({ content: "Ce concours n'existe plus.", ephemeral: true });
      return;
    }
    if (giveaway.ended) {
      await interaction.reply({ content: "Ce concours est terminé.", ephemeral: true });
      return;
    }
    if (giveaway.requiredRoleId) {
      const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
      if (!member?.roles.cache.has(giveaway.requiredRoleId)) {
        await interaction.reply({
          content: `Il faut le rôle <@&${giveaway.requiredRoleId}> pour participer.`,
          ephemeral: true,
        });
        return;
      }
    }
    if (giveaway.minAccountAgeDays > 0) {
      const age = accountAgeDays(interaction.user.createdAt);
      if (age < giveaway.minAccountAgeDays) {
        await interaction.reply({
          content: `Votre compte doit avoir au moins ${giveaway.minAccountAgeDays} jours.`,
          ephemeral: true,
        });
        return;
      }
    }

    const result = await this.services.giveaways.addEntrant(
      interaction.message.id,
      interaction.user.id,
    );
    if (!result.added) {
      await interaction.reply({ content: "Vous participez déjà. 🎉", ephemeral: true });
      return;
    }
    await interaction.reply({ content: "Vous participez ! Bonne chance. 🎉", ephemeral: true });
  }
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
    [ChannelType.GuildNewsThread]: "news thread",
    [ChannelType.PublicThread]: "thread",
    [ChannelType.PrivateThread]: "private thread",
  };
  return names[type] ?? "other";
}
