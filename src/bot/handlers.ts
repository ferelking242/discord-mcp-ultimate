import {
  type GuildMember,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type Role,
  type User,
} from "discord.js";

import { SlidingWindowLimiter } from "./rateLimit.js";
import type { ReactionRoleStore } from "./reactionRoles.js";

/** Minimal logger shape, so tests can pass a silent stub. */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface ReactionRoleHandlersOptions {
  store: ReactionRoleStore;
  logger: Logger;
  mode: "toggle" | "add-only";
  limiter: SlidingWindowLimiter;
  /** Whether a guild id is in the allow-list. */
  isGuildAllowed(guildId: string): boolean;
  /** Welcome-DM behaviour, kept here so the handler has no config dependency. */
  welcome: WelcomeOptions;
}

/** Welcome-DM options. */
export interface WelcomeOptions {
  enabled: boolean;
  message: string;
  inviteUrl?: string;
}

/**
 * Behaviour behind the reaction-role and welcome features.
 *
 * Every method takes already-fetched discord.js objects, and nothing here reads
 * `process.env` or constructs a client. That is what makes the logic testable
 * against plain objects instead of a live gateway connection.
 */
export class ReactionRoleHandlers {
  constructor(private readonly opts: ReactionRoleHandlersOptions) {}

  /**
   * Handles a reaction being added. Returns a short reason string describing what
   * happened, which the caller logs. Returning a reason rather than throwing keeps
   * the gateway event handler from needing a try/catch around every branch.
   */
  async onReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<string> {
    const guild = reaction.message.guild;
    if (!guild) return "ignored: not in a guild";
    if (user.bot) return "ignored: bot user";
    if (!this.opts.isGuildAllowed(guild.id)) return "ignored: guild not allow-listed";

    const key = `${guild.id}:${user.id}`;
    if (!this.opts.limiter.allow(key)) {
      return `throttled: ${user.id} over reaction limit`;
    }

    // A reaction on a message the bot has not cached arrives as a partial. Fetching
    // it is required before the store can be consulted by message id.
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    const emoji = reaction.emoji.id ? `:${reaction.emoji.name}:` : (reaction.emoji.name ?? "");

    const mapping = this.opts.store.find(guild.id, message.channelId, message.id, emoji);
    if (!mapping) return "ignored: no mapping for this reaction";

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return "failed: member not fetchable";

    const me = guild.members.me;
    if (!me) return "failed: bot member unavailable";

    const role =
      guild.roles.cache.get(mapping.roleId) ??
      (await guild.roles.fetch(mapping.roleId).catch(() => null));
    if (!role) {
      this.opts.logger.warn("reaction role missing", { roleId: mapping.roleId });
      return "failed: role no longer exists";
    }

    const problem = this.checkRoleGrantable(me, role);
    if (problem) {
      this.opts.logger.error("cannot grant role", { roleId: role.id, problem });
      return `failed: ${problem}`;
    }

    try {
      await member.roles.add(role, `Reaction role on message ${message.id}`);
      return `granted ${role.name} to ${user.id}`;
    } catch (err) {
      this.opts.logger.error("role add failed", { roleId: role.id, error: (err as Error).message });
      return `failed: ${(err as Error).message}`;
    }
  }

  /** Handles a reaction being removed, when the mode is `toggle`. */
  async onReactionRemove(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<string> {
    if (this.opts.mode !== "toggle") return "ignored: add-only mode";
    const guild = reaction.message.guild;
    if (!guild) return "ignored: not in a guild";
    if (user.bot) return "ignored: bot user";
    if (!this.opts.isGuildAllowed(guild.id)) return "ignored: guild not allow-listed";

    const key = `${guild.id}:${user.id}`;
    if (!this.opts.limiter.allow(key)) return `throttled: ${user.id} over reaction limit`;

    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    const emoji = reaction.emoji.id ? `:${reaction.emoji.name}:` : (reaction.emoji.name ?? "");
    const mapping = this.opts.store.find(guild.id, message.channelId, message.id, emoji);
    if (!mapping) return "ignored: no mapping for this reaction";

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return "failed: member not fetchable";

    const role =
      guild.roles.cache.get(mapping.roleId) ??
      (await guild.roles.fetch(mapping.roleId).catch(() => null));
    if (!role) return "failed: role no longer exists";
    if (!member.roles.cache.has(role.id)) return "no-op: member does not have the role";

    try {
      await member.roles.remove(role, `Reaction role removed on message ${message.id}`);
      return `removed ${role.name} from ${user.id}`;
    } catch (err) {
      this.opts.logger.error("role remove failed", {
        roleId: role.id,
        error: (err as Error).message,
      });
      return `failed: ${(err as Error).message}`;
    }
  }

  /** Sends the configured welcome DM, if enabled. Never throws. */
  async onMemberJoin(member: GuildMember): Promise<string> {
    if (!this.opts.isGuildAllowed(member.guild.id)) return "ignored: guild not allow-listed";
    if (!this.opts.welcome.enabled) return "ignored: welcome DM disabled";
    const text = this.opts.welcome.inviteUrl
      ? `${this.opts.welcome.message}\n\n${this.opts.welcome.inviteUrl}`
      : this.opts.welcome.message;
    try {
      await member.send(text);
      return `welcomed ${member.id}`;
    } catch {
      // Closed DMs are the common case, not an error worth a stack trace.
      return "skipped: member has DMs closed";
    }
  }

  /**
   * The checks Discord enforces on `roles.add`, run before the call so the failure
   * is a readable reason instead of an opaque 50013.
   */
  private checkRoleGrantable(me: GuildMember, role: Role): string | null {
    if (role.managed) return `role ${role.name} is managed by an integration`;
    if (!me.permissions.has("ManageRoles")) return "bot lacks ManageRoles";
    if (role.position >= me.roles.highest.position) {
      return `role ${role.name} sits at or above the bot's highest role`;
    }
    return null;
  }
}
