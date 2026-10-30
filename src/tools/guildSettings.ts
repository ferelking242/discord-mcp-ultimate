import {
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildOnboardingMode,
  GuildVerificationLevel,
  GuildWidgetStyle,
  PermissionFlagsBits,
  SystemChannelFlagsBitField,
  type GuildFeature,
  type Locale,
} from "discord.js";
import { z } from "zod";
import { assertBotPermission, getGuild, resolveImageInput } from "../client.js";
import { recordAction } from "../safety.js";
import { defineModule, defineTool, guildId, imageInput, structured } from "./define.js";

/** Channel kinds Discord accepts for the guild's AFK, system, rules and widget slots. */
const channelSlot = z
  .union([z.string(), z.null()])
  .describe(
    "Channel ID (snowflake), or null to clear the slot. The channel must be the right kind for the slot: voice for AFK, text or announcement for system/rules.",
  );

const guildSettingsSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  banner: z.string().nullable(),
  splash: z.string().nullable(),
  discovery_splash: z.string().nullable(),
  owner_id: z.string(),
  preferred_locale: z.string(),
  verification_level: z.string(),
  explicit_content_filter: z.string(),
  default_message_notifications: z.string(),
  mfa_level: z.string(),
  nsfw_level: z.string(),
  premium_tier: z.string(),
  premium_subscription_count: z.number().nullable(),
  premium_progress_bar_enabled: z.boolean(),
  system_channel_id: z.string().nullable(),
  rules_channel_id: z.string().nullable(),
  public_updates_channel_id: z.string().nullable(),
  safety_alerts_channel_id: z.string().nullable(),
  afk_channel_id: z.string().nullable(),
  afk_timeout: z.number(),
  features: z.array(z.string()),
  community_enabled: z.boolean(),
  vanity_url_code: z.string().nullable(),
  member_count: z.number(),
  approximate_presence_count: z.number(),
});

/**
 * Human-readable names for Discord's numeric enums, used in both the read and
 * write directions so the model never has to remember raw integers.
 */
const VERIFICATION_LEVELS: Record<string, GuildVerificationLevel> = {
  none: GuildVerificationLevel.None,
  low: GuildVerificationLevel.Low,
  medium: GuildVerificationLevel.Medium,
  high: GuildVerificationLevel.High,
  very_high: GuildVerificationLevel.VeryHigh,
};

const NOTIFICATION_LEVELS: Record<string, GuildDefaultMessageNotifications> = {
  all_messages: GuildDefaultMessageNotifications.AllMessages,
  only_mentions: GuildDefaultMessageNotifications.OnlyMentions,
};

const CONTENT_FILTERS: Record<string, GuildExplicitContentFilter> = {
  disabled: GuildExplicitContentFilter.Disabled,
  members_without_roles: GuildExplicitContentFilter.MembersWithoutRoles,
  all_members: GuildExplicitContentFilter.AllMembers,
};

/** Reverse lookup for a numeric enum, falling back to the raw number as a string. */
function enumName(table: Record<string, number>, value: number): string {
  const found = Object.entries(table).find(([, v]) => v === value);
  return found ? found[0] : String(value);
}

/**
 * Serialises a guild into the flat settings snapshot every tool in this module
 * reads or diffs against. One shape means `discord_get_guild_settings` and the
 * update tools can never disagree about what a setting is called.
 */
export async function readGuildSettings(guildId: string) {
  const guild = await getGuild(guildId);
  const vanity = guild.features.includes("VANITY_URL" as GuildFeature)
    ? await guild.fetchVanityData().catch(() => null)
    : null;
  return {
    id: guild.id,
    name: guild.name,
    description: guild.description,
    icon: guild.iconURL({ size: 1024 }),
    banner: guild.bannerURL({ size: 2048 }),
    splash: guild.splashURL({ size: 2048 }),
    discovery_splash: guild.discoverySplashURL({ size: 2048 }),
    owner_id: guild.ownerId,
    preferred_locale: guild.preferredLocale,
    verification_level: enumName(
      { none: 0, low: 1, medium: 2, high: 3, very_high: 4 },
      guild.verificationLevel,
    ),
    explicit_content_filter: enumName(
      { disabled: 0, members_without_roles: 1, all_members: 2 },
      guild.explicitContentFilter,
    ),
    default_message_notifications: enumName(
      { all_messages: 0, only_mentions: 1 },
      guild.defaultMessageNotifications,
    ),
    mfa_level: guild.mfaLevel === 0 ? "none" : "elevated",
    nsfw_level: enumName({ default: 0, explicit: 1, safe: 2, age_restricted: 3 }, guild.nsfwLevel),
    premium_tier: `tier_${guild.premiumTier}`,
    premium_subscription_count: guild.premiumSubscriptionCount,
    premium_progress_bar_enabled: guild.premiumProgressBarEnabled,
    system_channel_id: guild.systemChannelId,
    rules_channel_id: guild.rulesChannelId,
    public_updates_channel_id: guild.publicUpdatesChannelId,
    safety_alerts_channel_id: guild.safetyAlertsChannelId,
    afk_channel_id: guild.afkChannelId,
    afk_timeout: guild.afkTimeout,
    features: [...guild.features],
    community_enabled: guild.features.includes("COMMUNITY" as GuildFeature),
    vanity_url_code: vanity?.code ?? null,
    member_count: guild.memberCount,
    approximate_presence_count: guild.approximatePresenceCount ?? 0,
  };
}

/** Tool definitions for reading and modifying server-level settings. */
const tools = [
  defineTool({
    name: "discord_get_guild_settings",
    description:
      "Read every server-level setting in one call: name, description, icon/banner/splash URLs, owner, preferred locale, verification level, explicit content filter, default notification level, MFA requirement, NSFW level, boost tier, system/rules/public-updates/safety-alerts/AFK channel slots, AFK timeout, the full feature list, whether Community is enabled, and the vanity URL code. Read-only. Use this before any change so you know the current values, and use the targeted discord_set_* tools to change them.",
    annotations: { title: "Get server settings", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: guildSettingsSummary,
    handle: async ({ guild_id }) => structured(await readGuildSettings(guild_id)),
  }),
  defineTool({
    name: "discord_set_guild_name",
    description:
      "Change the server's name. This is the *guild* name shown at the top of the server list, not the bot's own name and not the bot's nickname in this server (use discord_set_bot_nickname for that). Requires Manage Server. Returns the previous and new name.",
    annotations: {
      title: "Rename server",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      name: z.string().min(2).max(100).describe("New server name (2–100 characters)."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({ id: z.string(), previous_name: z.string(), name: z.string() }),
    handle: async ({ guild_id, name, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "renaming the server");
      const previous = guild.name;
      const updated = await guild.setName(name, reason);
      recordAction({
        tool: "discord_set_guild_name",
        guildId: guild_id,
        summary: `Renamed "${previous}" -> "${updated.name}"`,
        outcome: "applied",
      });
      return structured({ id: updated.id, previous_name: previous, name: updated.name });
    },
  }),
  defineTool({
    name: "discord_set_guild_icon",
    description:
      "Replace the server's icon (the square image shown next to the server name). This is the *guild* icon; the bot's own avatar is changed with discord_set_bot_avatar. Accepts an https URL, a data: URI or base64. Requires Manage Server. Discord rejects images that are not PNG, JPEG, GIF or WebP or that exceed 10 MB. Returns the new icon URL.",
    annotations: {
      title: "Set server icon",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      image: imageInput,
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({ id: z.string(), icon: z.string().nullable() }),
    handle: async ({ guild_id, image, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "changing the server icon");
      const buffer = await resolveImageInput(image, "server icon");
      const updated = await guild.setIcon(buffer, reason);
      recordAction({
        tool: "discord_set_guild_icon",
        guildId: guild_id,
        summary: "Updated the server icon",
        outcome: "applied",
      });
      return structured({ id: updated.id, icon: updated.iconURL({ size: 1024 }) });
    },
  }),
  defineTool({
    name: "discord_remove_guild_icon",
    description:
      "Remove the server's icon, reverting to Discord's generated default. Requires Manage Server. This is not reversible: the previous image is gone. Returns the guild ID.",
    annotations: {
      title: "Remove server icon",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({ id: z.string(), icon: z.string().nullable() }),
    handle: async ({ guild_id, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "removing the server icon");
      const updated = await guild.setIcon(null, reason);
      recordAction({
        tool: "discord_remove_guild_icon",
        guildId: guild_id,
        summary: "Removed the server icon",
        outcome: "applied",
      });
      return structured({ id: updated.id, icon: updated.iconURL() });
    },
  }),
  defineTool({
    name: "discord_set_guild_banner",
    description:
      "Set or replace the server's banner, the wide image shown at the top of the server's landing page. IMPORTANT LIMITATION: Discord only renders a guild banner when the server has the BANNER feature (boost level 2+). Without it, Discord rejects the call with an error rather than accepting and hiding it. Requires Manage Server. Returns the new banner URL.",
    annotations: {
      title: "Set server banner",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      image: imageInput,
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({ id: z.string(), banner: z.string().nullable() }),
    handle: async ({ guild_id, image, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "changing the server banner");
      const buffer = await resolveImageInput(image, "server banner");
      const updated = await guild.setBanner(buffer, reason);
      recordAction({
        tool: "discord_set_guild_banner",
        guildId: guild_id,
        summary: "Updated the server banner",
        outcome: "applied",
      });
      return structured({ id: updated.id, banner: updated.bannerURL({ size: 2048 }) });
    },
  }),
  defineTool({
    name: "discord_remove_guild_banner",
    description:
      "Remove the server's banner. Requires Manage Server and the BANNER feature (boost level 2+). Not reversible. Returns the guild ID.",
    annotations: {
      title: "Remove server banner",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({ id: z.string(), banner: z.string().nullable() }),
    handle: async ({ guild_id, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "removing the server banner");
      const updated = await guild.setBanner(null, reason);
      recordAction({
        tool: "discord_remove_guild_banner",
        guildId: guild_id,
        summary: "Removed the server banner",
        outcome: "applied",
      });
      return structured({ id: updated.id, banner: updated.bannerURL() });
    },
  }),
  defineTool({
    name: "discord_set_guild_description",
    description:
      "Set or clear the server's description (the blurb shown on the server's landing page and in discovery). IMPORTANT LIMITATION: Discord only accepts a guild description when the server has the COMMUNITY feature. On a server without it, the call is rejected: call discord_enable_community first, or accept that this field cannot be set. Requires Manage Server. Pass null to clear it.",
    annotations: {
      title: "Set server description",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      description: z
        .string()
        .max(300)
        .nullable()
        .describe("New description (max 300 characters), or null to clear it."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({ id: z.string(), description: z.string().nullable() }),
    handle: async ({ guild_id, description, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "changing the server description");
      const updated = await guild.edit({ description, reason });
      recordAction({
        tool: "discord_set_guild_description",
        guildId: guild_id,
        summary: description ? "Updated the server description" : "Cleared the server description",
        outcome: "applied",
      });
      return structured({ id: updated.id, description: updated.description });
    },
  }),
  defineTool({
    name: "discord_set_guild_splash",
    description:
      "Set or remove the server's invite splash, the background shown on the invite page. Requires the INVITE_SPLASH feature (boost level 1+) and Manage Server. Pass null to remove it. Returns the new splash URL.",
    annotations: {
      title: "Set invite splash",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      image: imageInput
        .nullable()
        .describe("Image as a URL, data URI or base64, or null to remove."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({ id: z.string(), splash: z.string().nullable() }),
    handle: async ({ guild_id, image, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "changing the invite splash");
      const buffer = image === null ? null : await resolveImageInput(image, "invite splash");
      const updated = await guild.edit({ splash: buffer, reason });
      recordAction({
        tool: "discord_set_guild_splash",
        guildId: guild_id,
        summary: buffer ? "Updated the invite splash" : "Removed the invite splash",
        outcome: "applied",
      });
      return structured({ id: updated.id, splash: updated.splashURL({ size: 2048 }) });
    },
  }),
  defineTool({
    name: "discord_set_guild_safety",
    description:
      "Update the server's safety and moderation settings in one call: verification level, explicit content filter, default notification level, and the age-restricted (NSFW) content gate. Only provided fields change. Setting verification_level to high or very_high requires the server to be verified or partnered, otherwise Discord rejects it. Requires Manage Server. Returns the applied values.",
    annotations: {
      title: "Set safety settings",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      verification_level: z
        .enum(["none", "low", "medium", "high", "very_high"])
        .optional()
        .describe(
          "How much proof a new member must provide before they can talk. 'high' and 'very_high' require a verified/partnered server.",
        ),
      explicit_content_filter: z
        .enum(["disabled", "members_without_roles", "all_members"])
        .optional()
        .describe("Which members Discord scans media for."),
      default_message_notifications: z
        .enum(["all_messages", "only_mentions"])
        .optional()
        .describe("Default notification level for newly joined members."),
      nsfw: z
        .boolean()
        .optional()
        .describe(
          "Mark the whole server as age-restricted (true) or safe (false). Discord derives the NSFW level from this flag.",
        ),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({
      id: z.string(),
      verification_level: z.string(),
      explicit_content_filter: z.string(),
      default_message_notifications: z.string(),
    }),
    handle: async ({
      guild_id,
      verification_level,
      explicit_content_filter,
      default_message_notifications,
      nsfw,
      reason,
    }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "changing server safety settings");
      const updated = await guild.edit({
        verificationLevel:
          verification_level === undefined ? undefined : VERIFICATION_LEVELS[verification_level],
        explicitContentFilter:
          explicit_content_filter === undefined
            ? undefined
            : CONTENT_FILTERS[explicit_content_filter],
        defaultMessageNotifications:
          default_message_notifications === undefined
            ? undefined
            : NOTIFICATION_LEVELS[default_message_notifications],
        ...(nsfw === undefined ? {} : { nsfw }),
        reason,
      });
      recordAction({
        tool: "discord_set_guild_safety",
        guildId: guild_id,
        summary: "Updated safety/moderation settings",
        outcome: "applied",
      });
      return structured({
        id: updated.id,
        verification_level: enumName(
          { none: 0, low: 1, medium: 2, high: 3, very_high: 4 },
          updated.verificationLevel,
        ),
        explicit_content_filter: enumName(
          { disabled: 0, members_without_roles: 1, all_members: 2 },
          updated.explicitContentFilter,
        ),
        default_message_notifications: enumName(
          { all_messages: 0, only_mentions: 1 },
          updated.defaultMessageNotifications,
        ),
      });
    },
  }),
  defineTool({
    name: "discord_set_guild_channels",
    description:
      "Point the server's special channel slots at specific channels: the AFK channel and timeout, the system channel (where join/boost notices post), the rules channel, the public updates channel, and the safety alerts channel. Only provided slots change. The rules, public-updates and safety-alerts slots require the COMMUNITY feature; Discord rejects them otherwise. AFK must be a voice channel. Requires Manage Server. Returns the resulting slot IDs.",
    annotations: {
      title: "Set special channels",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      afk_channel_id: channelSlot.optional(),
      afk_timeout: z
        .int()
        .min(60)
        .max(3600)
        .optional()
        .describe(
          "Seconds of inactivity before moving a member to AFK (60–3600). Discord rounds down to 60/300/900/1800/3600.",
        ),
      system_channel_id: channelSlot.optional(),
      rules_channel_id: channelSlot.optional(),
      public_updates_channel_id: channelSlot.optional(),
      safety_alerts_channel_id: channelSlot.optional(),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({
      id: z.string(),
      afk_channel_id: z.string().nullable(),
      afk_timeout: z.number(),
      system_channel_id: z.string().nullable(),
      rules_channel_id: z.string().nullable(),
      public_updates_channel_id: z.string().nullable(),
      safety_alerts_channel_id: z.string().nullable(),
    }),
    handle: async ({
      guild_id,
      afk_channel_id,
      afk_timeout,
      system_channel_id,
      rules_channel_id,
      public_updates_channel_id,
      safety_alerts_channel_id,
      reason,
    }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "changing server channel settings");
      const updated = await guild.edit({
        afkChannel: afk_channel_id,
        afkTimeout: afk_timeout,
        systemChannel: system_channel_id,
        rulesChannel: rules_channel_id,
        publicUpdatesChannel: public_updates_channel_id,
        safetyAlertsChannel: safety_alerts_channel_id,
        reason,
      });
      recordAction({
        tool: "discord_set_guild_channels",
        guildId: guild_id,
        summary: "Updated special channel slots",
        outcome: "applied",
      });
      return structured({
        id: updated.id,
        afk_channel_id: updated.afkChannelId,
        afk_timeout: updated.afkTimeout,
        system_channel_id: updated.systemChannelId,
        rules_channel_id: updated.rulesChannelId,
        public_updates_channel_id: updated.publicUpdatesChannelId,
        safety_alerts_channel_id: updated.safetyAlertsChannelId,
      });
    },
  }),
  defineTool({
    name: "discord_set_system_channel_notices",
    description:
      "Toggle which automatic notices the system channel posts: join notifications, join-notification replies, boost/boost-tier messages, the 'server setup tips' reminder, and role-subscription purchase messages. Only provided flags change. Requires Manage Server. Returns the resulting flag set.",
    annotations: {
      title: "Set system notices",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      join_notifications: z.boolean().optional().describe("Post a message when a member joins."),
      join_notification_replies: z
        .boolean()
        .optional()
        .describe("Allow members to reply to the join message with a wave."),
      premium_subscriptions: z
        .boolean()
        .optional()
        .describe("Post boost messages when someone boosts the server."),
      guild_reminder_notifications: z
        .boolean()
        .optional()
        .describe("Post the 'server setup tips' reminder in the system channel."),
      role_subscription_purchases: z
        .boolean()
        .optional()
        .describe("Post messages when someone buys a role subscription."),
      role_subscription_replies: z
        .boolean()
        .optional()
        .describe("Allow replies to role-subscription purchase messages."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({ id: z.string(), enabled_notices: z.array(z.string()) }),
    handle: async ({ guild_id, reason, ...flags }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "changing system channel notices");
      const current = new SystemChannelFlagsBitField(guild.systemChannelFlags.bitfield);
      const mapping: Record<string, keyof typeof SystemChannelFlagsBitField.Flags> = {
        join_notifications: "SuppressJoinNotifications",
        join_notification_replies: "SuppressJoinNotificationReplies",
        premium_subscriptions: "SuppressPremiumSubscriptions",
        guild_reminder_notifications: "SuppressGuildReminderNotifications",
        role_subscription_purchases: "SuppressRoleSubscriptionPurchaseNotifications",
        role_subscription_replies: "SuppressRoleSubscriptionPurchaseNotificationReplies",
      };
      for (const [key, flag] of Object.entries(mapping)) {
        const value = (flags as Record<string, boolean | undefined>)[key];
        if (value !== undefined) {
          if (value) current.remove(flag);
          else current.add(flag);
        }
      }
      const updated = await guild.edit({ systemChannelFlags: current, reason });
      recordAction({
        tool: "discord_set_system_channel_notices",
        guildId: guild_id,
        summary: "Updated system channel notices",
        outcome: "applied",
      });
      const enabled = Object.entries(mapping)
        .filter(([, flag]) => !updated.systemChannelFlags.has(flag))
        .map(([key]) => key);
      return structured({ id: updated.id, enabled_notices: enabled });
    },
  }),
  defineTool({
    name: "discord_set_guild_locale",
    description:
      "Set the server's preferred language, which controls the language of Discord's own system messages and the default for members who have not chosen one. Requires Manage Server. Returns the previous and new locale.",
    annotations: {
      title: "Set server language",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      locale: z.string().describe("A Discord locale code such as 'fr', 'en-US', 'de' or 'ja'."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({ id: z.string(), previous_locale: z.string(), locale: z.string() }),
    handle: async ({ guild_id, locale, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "changing the server language");
      const previous = guild.preferredLocale;
      const updated = await guild.edit({ preferredLocale: locale as Locale, reason });
      recordAction({
        tool: "discord_set_guild_locale",
        guildId: guild_id,
        summary: `Locale ${previous} -> ${updated.preferredLocale}`,
        outcome: "applied",
      });
      return structured({
        id: updated.id,
        previous_locale: previous,
        locale: updated.preferredLocale,
      });
    },
  }),
  defineTool({
    name: "discord_set_premium_progress_bar",
    description:
      "Show or hide the boost progress bar in the server's channel list. Requires Manage Server. Returns the resulting value.",
    annotations: {
      title: "Toggle boost progress bar",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      enabled: z.boolean().describe("True to show the boost progress bar, false to hide it."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({ id: z.string(), premium_progress_bar_enabled: z.boolean() }),
    handle: async ({ guild_id, enabled, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "changing the boost progress bar");
      const updated = await guild.edit({ premiumProgressBarEnabled: enabled, reason });
      recordAction({
        tool: "discord_set_premium_progress_bar",
        guildId: guild_id,
        summary: `Boost progress bar -> ${enabled}`,
        outcome: "applied",
      });
      return structured({
        id: updated.id,
        premium_progress_bar_enabled: updated.premiumProgressBarEnabled,
      });
    },
  }),
  defineTool({
    name: "discord_enable_community",
    description:
      "Turn the Community feature on or off for the server. COMMUNITY is the prerequisite for rules and public-updates channels, membership screening, the welcome screen, onboarding and AutoMod. LIMITATION: Discord requires the server to already have a rules channel and a public-updates channel before Community can be enabled, so create those first (discord_create_channel, then discord_set_guild_channels). Requires Manage Server. Returns the resulting feature list.",
    annotations: {
      title: "Toggle Community feature",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      enabled: z.boolean().describe("True to enable Community, false to disable it."),
      rules_channel_id: z
        .string()
        .optional()
        .describe("Rules channel to register while enabling. Required by Discord on first enable."),
      public_updates_channel_id: z
        .string()
        .optional()
        .describe("Public-updates channel to register while enabling. Required on first enable."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({
      id: z.string(),
      community_enabled: z.boolean(),
      features: z.array(z.string()),
      missing_prerequisites: z.array(z.string()),
      prerequisite_check_only: z.boolean(),
    }),
    handle: async ({ guild_id, enabled, rules_channel_id, public_updates_channel_id, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "changing the Community feature");

      // Discord rejects the first enable with a bare 400 unless a rules channel
      // and a public-updates channel are supplied, and requires the rules channel
      // to be an actual text channel with the Community-appropriate settings.
      const missing: string[] = [];
      if (enabled) {
        const rulesId = rules_channel_id ?? guild.rulesChannelId;
        const updatesId = public_updates_channel_id ?? guild.publicUpdatesChannelId;
        if (!rulesId)
          missing.push(
            "No rules channel: pass rules_channel_id, or create one first with discord_create_channel and register it.",
          );
        else {
          const rules = await guild.channels.fetch(rulesId).catch(() => null);
          if (!rules)
            missing.push(
              `rules_channel_id ${rulesId} does not resolve to a channel in this server.`,
            );
        }
        if (!updatesId)
          missing.push(
            "No public-updates channel: pass public_updates_channel_id, or create one first with discord_create_channel and register it.",
          );
        else {
          const updates = await guild.channels.fetch(updatesId).catch(() => null);
          if (!updates)
            missing.push(
              `public_updates_channel_id ${updatesId} does not resolve to a channel in this server.`,
            );
        }
      }
      if (missing.length > 0)
        return structured({
          id: guild.id,
          community_enabled: guild.features.includes("COMMUNITY" as GuildFeature),
          features: [...guild.features],
          missing_prerequisites: missing,
          prerequisite_check_only: true,
        });

      const features = new Set<string>(guild.features);
      if (enabled) features.add("COMMUNITY");
      else features.delete("COMMUNITY");
      const updated = await guild.edit({
        features: [...features] as GuildFeature[],
        rulesChannel: rules_channel_id,
        publicUpdatesChannel: public_updates_channel_id,
        reason,
      });
      recordAction({
        tool: "discord_enable_community",
        guildId: guild_id,
        summary: `Community -> ${enabled}`,
        outcome: "applied",
      });
      return structured({
        id: updated.id,
        community_enabled: updated.features.includes("COMMUNITY" as GuildFeature),
        features: [...updated.features],
        missing_prerequisites: [],
        prerequisite_check_only: false,
      });
    },
  }),
  defineTool({
    name: "discord_get_guild_features",
    description:
      "List the server's feature flags with a plain-language explanation of the ones that gate this server's tools (COMMUNITY, DISCOVERABLE, BANNER, INVITE_SPLASH, VANITY_URL, ANIMATED_ICON, ANIMATED_BANNER, ROLE_ICONS, NEWS, FORUM_CHANNEL_ENABLED, MEMBER_VERIFICATION_GATE_ENABLED, AUTO_MODERATION) and which are currently active. Also reports which settings are therefore editable. Read-only. Use this before attempting a setting that may be feature-gated.",
    annotations: { title: "Explain guild features", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({
      id: z.string(),
      features: z.array(z.string()),
      capabilities: z.array(
        z.object({ feature: z.string(), active: z.boolean(), unlocks: z.string() }),
      ),
    }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      const capabilities = [
        {
          feature: "COMMUNITY",
          unlocks:
            "Rules/public-updates channels, welcome screen, onboarding, AutoMod, membership screening",
        },
        { feature: "DISCOVERABLE", unlocks: "Server discovery listing (needs Community)" },
        { feature: "BANNER", unlocks: "Server banner and animated banner (boost level 2+)" },
        { feature: "INVITE_SPLASH", unlocks: "Invite splash background (boost level 1+)" },
        { feature: "VANITY_URL", unlocks: "Custom discord.gg invite URL" },
        { feature: "ANIMATED_ICON", unlocks: "Animated server icon (boost level 1+)" },
        { feature: "ROLE_ICONS", unlocks: "Custom role icons (boost level 2+)" },
        { feature: "NEWS", unlocks: "Announcement channels" },
        { feature: "FORUM_CHANNEL_ENABLED", unlocks: "Forum channels" },
        { feature: "MEMBER_VERIFICATION_GATE_ENABLED", unlocks: "Membership screening form" },
        { feature: "AUTO_MODERATION", unlocks: "AutoMod rules" },
        { feature: "WELCOME_SCREEN_ENABLED", unlocks: "Server welcome screen" },
      ].map(({ feature, unlocks }) => ({
        feature,
        active: guild.features.includes(feature as GuildFeature),
        unlocks,
      }));
      return structured({ id: guild.id, features: [...guild.features], capabilities });
    },
  }),
  defineTool({
    name: "discord_get_guild_preview",
    description:
      "Fetch the public preview of a server: approximate member and online counts, description, icon, splash, emojis, stickers and features. Works without being a member, but Discord only serves a rich preview for servers that are discoverable or have Community enabled. Read-only.",
    annotations: { title: "Preview server", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      approximate_member_count: z.number(),
      approximate_presence_count: z.number(),
      icon: z.string().nullable(),
      splash: z.string().nullable(),
      features: z.array(z.string()),
      emoji_count: z.number(),
      sticker_count: z.number(),
    }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      const preview = await guild.fetchPreview();
      return structured({
        id: preview.id,
        name: preview.name,
        description: preview.description,
        approximate_member_count: preview.approximateMemberCount,
        approximate_presence_count: preview.approximatePresenceCount,
        icon: preview.iconURL({ size: 1024 }),
        splash: preview.splashURL({ size: 2048 }),
        features: [...preview.features],
        emoji_count: preview.emojis.size,
        sticker_count: preview.stickers.size,
      });
    },
  }),
  defineTool({
    name: "discord_get_guild_vanity_url",
    description:
      "Read the server's vanity invite URL, the custom discord.gg link. Requires the VANITY_URL feature. Read-only. Use discord_get_guild_features to check whether the feature is active first.",
    annotations: { title: "Get vanity URL", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({ code: z.string().nullable(), url: z.string().nullable() }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      const vanity = await guild.fetchVanityData().catch(() => null);
      return structured({
        code: vanity?.code ?? null,
        url: vanity ? `https://discord.gg/${vanity.code}` : null,
      });
    },
  }),
  defineTool({
    name: "discord_set_guild_widget",
    description:
      "Configure the server's embeddable widget: whether it is enabled and which channel it exposes. Enabling the widget publishes a live member list and online count to anyone with the widget URL, so treat it as a privacy decision. Requires Manage Server. Returns the resulting settings. Use discord_get_guild_widget to read the current state and the public URLs.",
    annotations: {
      title: "Set server widget",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      enabled: z.boolean().describe("True to enable the widget, false to disable it."),
      channel_id: channelSlot
        .optional()
        .describe("Channel the widget points at, or null for none."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({
      id: z.string(),
      enabled: z.boolean(),
      channel_id: z.string().nullable(),
    }),
    handle: async ({ guild_id, enabled, channel_id, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "changing the server widget");
      await guild.setWidgetSettings({ enabled, channel: (channel_id ?? null) as never }, reason);
      recordAction({
        tool: "discord_set_guild_widget",
        guildId: guild_id,
        summary: `Widget -> enabled=${enabled}, channel=${channel_id ?? "none"}`,
        outcome: "applied",
      });
      const settings = await guild.fetchWidgetSettings();
      return structured({
        id: guild.id,
        enabled: settings.enabled,
        channel_id: settings.channel?.id ?? null,
      });
    },
  }),
  defineTool({
    name: "discord_get_guild_widget",
    description:
      "Read the server's widget settings and, when the widget is enabled, the public widget.json and widget image URLs. The JSON endpoint is readable by anyone who has the URL, so this tool reports exactly what it exposes. Read-only.",
    annotations: { title: "Get server widget", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({
      enabled: z.boolean(),
      channel_id: z.string().nullable(),
      widget_json_url: z.string().nullable(),
      widget_image_url: z.string().nullable(),
    }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      const settings = await guild.fetchWidgetSettings().catch(() => null);
      const enabled = settings?.enabled ?? false;
      return structured({
        enabled,
        channel_id: settings?.channel?.id ?? null,
        widget_json_url: enabled ? `https://discord.com/api/guilds/${guild.id}/widget.json` : null,
        widget_image_url: enabled ? guild.widgetImageURL(GuildWidgetStyle.Banner1) : null,
      });
    },
  }),
  defineTool({
    name: "discord_get_welcome_screen",
    description:
      "Read the server's welcome screen: whether it is enabled, its description, and the channels it recommends with their emoji and descriptions. Requires the COMMUNITY feature. Read-only. Use discord_set_welcome_screen to change it.",
    annotations: { title: "Get welcome screen", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({
      enabled: z.boolean(),
      description: z.string().nullable(),
      welcome_channels: z.array(
        z.object({
          channel_id: z.string(),
          description: z.string(),
          emoji: z.string().nullable(),
        }),
      ),
    }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      const screen = await guild.fetchWelcomeScreen();
      return structured({
        enabled: screen.enabled,
        description: screen.description,
        welcome_channels: [...screen.welcomeChannels.values()].map((wc) => ({
          channel_id: wc.channelId,
          description: wc.description,
          emoji: wc.emoji?.toString() ?? null,
        })),
      });
    },
  }),
  defineTool({
    name: "discord_set_welcome_screen",
    description:
      "Configure the server's welcome screen: enable or disable it, set the headline description, and list the recommended channels with a one-line blurb each. Requires the COMMUNITY feature and Manage Server. LIMITATION: Discord requires the description to be non-empty and at least one recommended channel when the screen is enabled. Replaces the channel list wholesale when provided. Returns the resulting screen.",
    annotations: {
      title: "Set welcome screen",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      enabled: z.boolean().optional().describe("Enable or disable the welcome screen."),
      description: z
        .string()
        .max(140)
        .optional()
        .describe("Headline shown at the top (max 140 chars)."),
      welcome_channels: z
        .array(
          z.strictObject({
            channel_id: z.string().describe("Channel to recommend (snowflake)."),
            description: z.string().max(50).describe("One-line blurb (max 50 characters)."),
            emoji: z.string().optional().describe("Optional custom emoji name or unicode emoji."),
          }),
        )
        .max(5)
        .optional()
        .describe("Recommended channels (Discord allows up to 5). Replaces the existing list."),
    }),
    outputSchema: z.object({
      enabled: z.boolean(),
      description: z.string().nullable(),
      welcome_channels: z.array(
        z.object({ channel_id: z.string(), description: z.string(), emoji: z.string().nullable() }),
      ),
    }),
    handle: async ({ guild_id, enabled, description, welcome_channels }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "changing the welcome screen");
      const updated = await guild.editWelcomeScreen({
        enabled,
        description,
        welcomeChannels: welcome_channels?.map((wc) => ({
          channel: wc.channel_id,
          description: wc.description,
          emoji: wc.emoji,
        })),
      });
      recordAction({
        tool: "discord_set_welcome_screen",
        guildId: guild_id,
        summary: "Updated the welcome screen",
        outcome: "applied",
      });
      return structured({
        enabled: updated.enabled,
        description: updated.description,
        welcome_channels: [...updated.welcomeChannels.values()].map((wc) => ({
          channel_id: wc.channelId,
          description: wc.description,
          emoji: wc.emoji?.toString() ?? null,
        })),
      });
    },
  }),
  defineTool({
    name: "discord_get_onboarding",
    description:
      "Read the server's onboarding configuration: whether it is enabled, its mode (default or advanced), the default channels new members land in, and every onboarding prompt with its options, each option's channels and roles. Requires the COMMUNITY feature. Read-only. Use discord_set_onboarding to change it.",
    annotations: { title: "Get onboarding", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({
      enabled: z.boolean(),
      mode: z.string(),
      default_channel_ids: z.array(z.string()),
      prompts: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          single_select: z.boolean(),
          required: z.boolean(),
          in_onboarding: z.boolean(),
          options: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              description: z.string().nullable(),
              channel_ids: z.array(z.string()),
              role_ids: z.array(z.string()),
            }),
          ),
        }),
      ),
    }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      const onboarding = await guild.fetchOnboarding();
      return structured({
        enabled: onboarding.enabled,
        mode: onboarding.mode === GuildOnboardingMode.OnboardingAdvanced ? "advanced" : "default",
        default_channel_ids: [...onboarding.defaultChannels.keys()],
        prompts: [...onboarding.prompts.values()].map((prompt) => ({
          id: prompt.id,
          title: prompt.title,
          single_select: prompt.singleSelect,
          required: prompt.required,
          in_onboarding: prompt.inOnboarding,
          options: [...prompt.options.values()].map((option) => ({
            id: option.id,
            title: option.title,
            description: option.description,
            channel_ids: [...option.channels.keys()],
            role_ids: [...option.roles.keys()],
          })),
        })),
      });
    },
  }),
  defineTool({
    name: "discord_set_onboarding",
    description:
      "Configure the server's onboarding flow: enable or disable it, pick the default channels new members see, and define the prompts with their options (each option can grant roles and point at channels). Requires the COMMUNITY feature and Manage Server. LIMITATION: Discord requires at least seven default channels and one prompt with at least one option for advanced mode; an incomplete configuration is rejected. Replaces the prompt list wholesale when provided. Returns the resulting configuration.",
    annotations: {
      title: "Set onboarding",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      enabled: z.boolean().optional().describe("Enable or disable onboarding."),
      mode: z
        .enum(["default", "advanced"])
        .optional()
        .describe(
          "'default' keeps Discord's built-in prompts; 'advanced' uses the ones you supply.",
        ),
      default_channel_ids: z
        .array(z.string())
        .optional()
        .describe(
          "Channels new members are dropped into. Discord requires at least 7 for advanced mode.",
        ),
      prompts: z
        .array(
          z.strictObject({
            title: z.string().describe("Question shown to the new member."),
            single_select: z.boolean().optional().describe("Allow only one option to be picked."),
            required: z.boolean().optional().describe("Require an answer before continuing."),
            in_onboarding: z
              .boolean()
              .optional()
              .describe("Show this prompt in the onboarding flow."),
            options: z
              .array(
                z.strictObject({
                  title: z.string().describe("Option label."),
                  description: z.string().optional().describe("Optional explanation."),
                  emoji: z.string().optional().describe("Optional emoji shown with the option."),
                  role_ids: z
                    .array(z.string())
                    .optional()
                    .describe("Roles granted by this option."),
                  channel_ids: z
                    .array(z.string())
                    .optional()
                    .describe("Channels this option reveals."),
                }),
              )
              .min(1)
              .describe("Options for this prompt."),
          }),
        )
        .optional()
        .describe("Onboarding prompts. Replaces the existing set."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({
      enabled: z.boolean(),
      mode: z.string(),
      default_channel_ids: z.array(z.string()),
      prompt_count: z.number(),
    }),
    handle: async ({ guild_id, enabled, mode, default_channel_ids, prompts, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "changing onboarding");
      const updated = await guild.editOnboarding({
        enabled,
        mode:
          mode === undefined
            ? undefined
            : mode === "advanced"
              ? GuildOnboardingMode.OnboardingAdvanced
              : GuildOnboardingMode.OnboardingDefault,
        defaultChannels: default_channel_ids,
        prompts: prompts?.map((prompt) => ({
          title: prompt.title,
          singleSelect: prompt.single_select,
          required: prompt.required,
          inOnboarding: prompt.in_onboarding,
          options: prompt.options.map((option) => ({
            title: option.title,
            description: option.description,
            emoji: option.emoji,
            roles: option.role_ids,
            channels: option.channel_ids,
          })),
        })),
        reason,
      });
      recordAction({
        tool: "discord_set_onboarding",
        guildId: guild_id,
        summary: "Updated onboarding",
        outcome: "applied",
      });
      return structured({
        enabled: updated.enabled,
        mode: updated.mode === GuildOnboardingMode.OnboardingAdvanced ? "advanced" : "default",
        default_channel_ids: [...updated.defaultChannels.keys()],
        prompt_count: updated.prompts.size,
      });
    },
  }),
  defineTool({
    name: "discord_get_bot_permissions",
    description:
      "Report what this bot can and cannot do in a server: its server-wide permissions, its role position versus the server owner, and whether it holds each permission the other tools in this server depend on. Read-only. Call this when a tool fails with 'Missing permissions' to find out which permission to grant.",
    annotations: { title: "Check bot permissions", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({
      guild_id: z.string(),
      guild_name: z.string(),
      bot_id: z.string().nullable(),
      bot_role_position: z.number(),
      highest_role: z.string().nullable(),
      is_owner: z.boolean(),
      has_all_required: z.boolean(),
      permissions: z.array(
        z.object({ permission: z.string(), granted: z.boolean(), used_by: z.string() }),
      ),
    }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      const me = guild.members.me;
      const required: [keyof typeof PermissionFlagsBits, string][] = [
        ["ManageGuild", "server settings, widget, welcome screen, onboarding"],
        ["ManageChannels", "creating, editing, moving and deleting channels"],
        ["ManageRoles", "roles, role icons and channel permission overwrites"],
        ["ManageMessages", "bulk delete, pinning, crossposting"],
        ["ManageWebhooks", "webhooks and following announcement channels"],
        ["ManageNicknames", "changing other members' nicknames"],
        ["KickMembers", "kick and prune"],
        ["BanMembers", "ban, unban and bulk ban"],
        ["ModerateMembers", "timeouts"],
        ["ViewAuditLog", "reading the audit log"],
        ["ManageEvents", "scheduled events"],
        ["CreateInstantInvite", "creating invites"],
        ["SendMessages", "sending messages"],
        ["EmbedLinks", "sending embeds"],
        ["ReadMessageHistory", "reading messages"],
        ["AddReactions", "reactions"],
        ["CreatePublicThreads", "creating threads"],
        ["ManageThreads", "managing threads and forum posts"],
        ["ManageEmojisAndStickers", "server emojis and stickers"],
        ["ManageGuild", "AutoMod rules (Discord gates /auto-moderation on Manage Server)"],
      ];
      const permissions = required.map(([permission, used_by]) => ({
        permission,
        granted: me ? me.permissions.has(permission) : false,
        used_by,
      }));
      return structured({
        guild_id: guild.id,
        guild_name: guild.name,
        bot_id: me?.id ?? null,
        bot_role_position: me?.roles.highest.position ?? -1,
        highest_role: me?.roles.highest.name ?? null,
        is_owner: guild.ownerId === me?.id,
        has_all_required: permissions.every((p) => p.granted),
        permissions,
      });
    },
  }),
];

const MEMBERSHIP_GATE_FEATURE = "MEMBER_VERIFICATION_GATE_ENABLED" as const;

tools.push(
  defineTool({
    name: "discord_set_membership_gate",
    description:
      "Turn the membership screening gate on or off by adding or removing the MEMBER_VERIFICATION_GATE_ENABLED feature. LIMITATION, verified against a live server: Discord returns HTTP 200 but silently ignores an API request to ADD this feature, so enabling it from here does not work. It must be turned on once by hand in the Discord client (Server Settings > Safety Setup > Membership Screening). Disabling it through this tool does work. The returned 'enabled' field always reflects the real state after the call, so treat enabled:false as Discord having refused. Requires the COMMUNITY feature and Manage Server.",
    annotations: {
      title: "Set membership gate",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      enabled: z
        .boolean()
        .describe("true to gate new members behind the screening form, false to stop gating."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({
      id: z.string(),
      enabled: z.boolean(),
      features: z.array(z.string()),
    }),
    handle: async ({ guild_id, enabled, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "changing the membership gate");
      const wasEnabled = guild.features.includes(MEMBERSHIP_GATE_FEATURE);
      const features = new Set<string>(guild.features);
      if (enabled) features.add(MEMBERSHIP_GATE_FEATURE);
      else features.delete(MEMBERSHIP_GATE_FEATURE);
      const updated = await guild.edit({
        features: [...features] as GuildFeature[],
        ...(reason ? { reason } : {}),
      });
      recordAction({
        tool: "discord_set_membership_gate",
        guildId: guild_id,
        summary: `Membership gate ${wasEnabled ? "on" : "off"} -> ${enabled ? "on" : "off"}`,
        outcome: "applied",
      });
      return structured({
        id: updated.id,
        enabled: updated.features.includes(MEMBERSHIP_GATE_FEATURE),
        features: [...updated.features],
      });
    },
  }),
);

export default defineModule(tools);
