import { z } from "zod";
import { discord, getGuild, resolveImageInput } from "../client.js";
import { recordAction } from "../safety.js";
import { defineModule, defineTool, guildId, imageInput, structured } from "./define.js";

/**
 * Tools that change the *bot's own* identity, as opposed to the server's.
 *
 * This module exists because the four things that are easy to confuse are, in
 * fact, four different Discord resources with four different endpoints:
 *
 * | Concept                          | Endpoint                        | Tool                       |
 * | -------------------------------- | ------------------------------- | -------------------------- |
 * | Guild name (the server's name)   | PATCH /guilds/{id}              | discord_set_guild_name     |
 * | Guild icon                       | PATCH /guilds/{id}              | discord_set_guild_icon     |
 * | Bot nickname in one guild        | PATCH /guilds/{id}/members/@me  | discord_set_bot_nickname   |
 * | Bot avatar (all guilds)          | PATCH /users/@me                | discord_set_bot_avatar     |
 * | Bot username (all guilds)        | PATCH /users/@me                | discord_set_bot_username   |
 * | Application icon / description   | PATCH /applications/@me         | discord_set_application_... |
 * | Bot banner (user profile banner) | PATCH /users/@me (banner field)| not exposed, see notes     |
 *
 * Changing the nickname is per-guild and instantly visible; changing the avatar
 * or username is global and Discord heavily rate-limits the username.
 */

const tools = [
  defineTool({
    name: "discord_get_bot_identity",
    description:
      "Report the bot's own identity, distinguishing the things that are commonly confused: its global username and avatar (which apply in every server), its per-server nickname and per-server avatar in this guild, and the owning application's name and ID. Read-only. Use this before changing anything so you know which of the four you actually mean.",
    annotations: { title: "Get bot identity", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({
      bot_user_id: z.string().nullable(),
      global_username: z.string().nullable(),
      global_display_name: z.string().nullable(),
      global_avatar: z.string().nullable(),
      application_id: z.string().nullable(),
      application_name: z.string().nullable(),
      application_description: z.string().nullable(),
      application_icon: z.string().nullable(),
      guild_nickname: z.string().nullable(),
      guild_display_name: z.string().nullable(),
      guild_avatar: z.string().nullable(),
      guild_id: z.string(),
      guild_name: z.string(),
      can_change_nickname: z.boolean(),
      notes: z.array(z.string()),
    }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      const user = discord.user;
      const me = guild.members.me;
      const application = discord.application;
      return structured({
        bot_user_id: user?.id ?? null,
        global_username: user?.username ?? null,
        global_display_name: user?.globalName ?? null,
        global_avatar: user?.displayAvatarURL({ size: 1024 }) ?? null,
        application_id: application?.id ?? null,
        application_name: application?.name ?? null,
        application_description: application?.description ?? null,
        application_icon: application?.iconURL({ size: 1024 }) ?? null,
        guild_nickname: me?.nickname ?? null,
        guild_display_name: me?.displayName ?? null,
        guild_avatar: me?.displayAvatarURL({ size: 1024 }) ?? null,
        guild_id: guild.id,
        guild_name: guild.name,
        can_change_nickname: me?.manageable ?? false,
        notes: [
          "The bot's global username and avatar apply in every server and are changed with discord_set_bot_username / discord_set_bot_avatar.",
          "The bot's nickname is per-server and is changed with discord_set_bot_nickname.",
          "Discord rate-limits username changes hard (roughly twice per hour) and rejects names that are already taken.",
          "A bot's profile banner is a user-level field Discord exposes only to user accounts; a bot token cannot set it. This server does not pretend otherwise.",
          "The application icon is a separate resource from the bot avatar and is changed with discord_set_application_icon.",
        ],
      });
    },
  }),
  defineTool({
    name: "discord_set_bot_nickname",
    description:
      "Change the bot's own nickname in one server. This is per-server: it does not affect the bot's name in other servers, nor its global username. Pass null to clear the nickname and fall back to the global username. Requires the Change Nickname permission for the bot itself, or Manage Nicknames if changing on its own behalf is restricted. Returns the previous and new nickname.",
    annotations: {
      title: "Set bot nickname",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      nickname: z
        .string()
        .max(32)
        .nullable()
        .describe("New nickname (max 32 characters), or null to clear it."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({
      guild_id: z.string(),
      previous_nickname: z.string().nullable(),
      nickname: z.string().nullable(),
    }),
    handle: async ({ guild_id, nickname, reason }) => {
      const guild = await getGuild(guild_id);
      const me = guild.members.me;
      if (!me)
        throw new Error("Bot member is not cached in this guild; cannot change its nickname.");
      const previous = me.nickname;
      const updated = await guild.members.editMe({ nick: nickname, reason });
      recordAction({
        tool: "discord_set_bot_nickname",
        guildId: guild_id,
        summary: `Bot nickname "${previous ?? "(none)"}" -> "${nickname ?? "(cleared)"}"`,
        outcome: "applied",
      });
      return structured({
        guild_id,
        previous_nickname: previous,
        nickname: updated.nickname,
      });
    },
  }),
  defineTool({
    name: "discord_set_bot_avatar",
    description:
      "Change the bot's global avatar. This applies in every server and in DMs, and is not the same as the server's icon (discord_set_guild_icon) or the bot's per-server avatar (discord_set_bot_guild_avatar). Accepts an https URL, data: URI or base64; PNG, JPEG, GIF or WebP up to 10 MB. Returns the new avatar URL. WARNING: Discord rate-limits this endpoint; repeated calls will be throttled.",
    annotations: {
      title: "Set bot avatar",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      image: imageInput,
    }),
    outputSchema: z.object({ avatar: z.string().nullable() }),
    handle: async ({ image }) => {
      const buffer = await resolveImageInput(image, "bot avatar");
      const updated = await discord.user!.setAvatar(buffer);
      recordAction({
        tool: "discord_set_bot_avatar",
        guildId: null,
        summary: "Updated the bot's global avatar",
        outcome: "applied",
      });
      return structured({ avatar: updated.displayAvatarURL({ size: 1024 }) });
    },
  }),
  defineTool({
    name: "discord_set_bot_guild_avatar",
    description:
      "Set the bot's per-server avatar, which overrides the global avatar in that one server. Requires the server to have the BANNER or ROLE_ICONS-adjacent boost feature set that Discord requires for per-guild member avatars; on a server without it Discord rejects the call. Accepts an https URL, data: URI or base64. Pass null to clear it and fall back to the global avatar. Returns the resulting per-server avatar URL.",
    annotations: {
      title: "Set bot per-server avatar",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      image: imageInput
        .nullable()
        .describe("Image as a URL, data URI or base64, or null to clear."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({ guild_id: z.string(), guild_avatar: z.string().nullable() }),
    handle: async ({ guild_id, image, reason }) => {
      const guild = await getGuild(guild_id);
      const buffer =
        image === null ? null : await resolveImageInput(image, "bot per-server avatar");
      const updated = await guild.members.editMe({ avatar: buffer, reason });
      recordAction({
        tool: "discord_set_bot_guild_avatar",
        guildId: guild_id,
        summary: buffer
          ? "Updated the bot's per-server avatar"
          : "Cleared the bot's per-server avatar",
        outcome: "applied",
      });
      return structured({
        guild_id,
        guild_avatar: updated.displayAvatarURL({ size: 1024 }),
      });
    },
  }),
  defineTool({
    name: "discord_set_bot_username",
    description:
      "Change the bot's global username. WARNING: this is the most rate-limited endpoint Discord offers (roughly two changes per hour), it applies in every server, and Discord may reject names that are taken or reserved. If the call is throttled it will fail with a 429 and you must wait. This does not change the server name or the bot's nickname. Returns the new username.",
    annotations: {
      title: "Set bot username",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      username: z.string().min(2).max(32).describe("New global username (2–32 characters)."),
    }),
    outputSchema: z.object({ previous_username: z.string().nullable(), username: z.string() }),
    handle: async ({ username }) => {
      const previous = discord.user?.username ?? null;
      const updated = await discord.user!.setUsername(username);
      recordAction({
        tool: "discord_set_bot_username",
        guildId: null,
        summary: `Bot username "${previous}" -> "${updated.username}"`,
        outcome: "applied",
      });
      return structured({ previous_username: previous, username: updated.username });
    },
  }),
  defineTool({
    name: "discord_set_application_icon",
    description:
      "Change the owning application's icon, which is what Discord shows in the OAuth2 authorization screen and in the developer portal. This is a different image from the bot's avatar and from the server icon. Requires the application to be owned by the token's owner. Accepts an https URL, data: URI or base64. Returns the new icon URL.",
    annotations: {
      title: "Set application icon",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      image: imageInput,
    }),
    outputSchema: z.object({ application_id: z.string(), icon: z.string().nullable() }),
    handle: async ({ image }) => {
      const application = discord.application;
      if (!application) throw new Error("Application data is not available; is the client ready?");
      const buffer = await resolveImageInput(image, "application icon");
      const updated = await application.edit({ icon: buffer });
      recordAction({
        tool: "discord_set_application_icon",
        guildId: null,
        summary: "Updated the application icon",
        outcome: "applied",
      });
      return structured({
        application_id: updated.id,
        icon: updated.iconURL({ size: 1024 }),
      });
    },
  }),
  defineTool({
    name: "discord_set_application_description",
    description:
      "Change the owning application's description, shown on the OAuth2 authorization screen and in the developer portal. This is not the server's description (discord_set_guild_description). Requires the application to be owned by the token's owner. Returns the new description.",
    annotations: {
      title: "Set application description",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      description: z
        .string()
        .max(400)
        .describe("New application description (max 400 characters)."),
    }),
    outputSchema: z.object({ application_id: z.string(), description: z.string().nullable() }),
    handle: async ({ description }) => {
      const application = discord.application;
      if (!application) throw new Error("Application data is not available; is the client ready?");
      const updated = await application.edit({ description });
      recordAction({
        tool: "discord_set_application_description",
        guildId: null,
        summary: "Updated the application description",
        outcome: "applied",
      });
      return structured({ application_id: updated.id, description: updated.description });
    },
  }),
  defineTool({
    name: "discord_get_bot_profile_limits",
    description:
      "Explain, from the live client state, exactly which parts of the bot's profile this server can and cannot change, and why. Read-only. Use this when asked to change the bot's banner, its 'about me', or anything else Discord does not expose to bot accounts: the answer is a documented limitation, not a missing tool.",
    annotations: { title: "Explain bot profile limits", readOnlyHint: true, openWorldHint: false },
    schema: z.object({}),
    outputSchema: z.object({
      changeable: z.array(z.object({ field: z.string(), scope: z.string(), tool: z.string() })),
      not_changeable: z.array(z.object({ field: z.string(), reason: z.string() })),
    }),
    handle: async () =>
      structured({
        changeable: [
          { field: "global username", scope: "all servers", tool: "discord_set_bot_username" },
          { field: "global avatar", scope: "all servers", tool: "discord_set_bot_avatar" },
          { field: "per-server nickname", scope: "one server", tool: "discord_set_bot_nickname" },
          {
            field: "per-server avatar",
            scope: "one server",
            tool: "discord_set_bot_guild_avatar",
          },
          { field: "application icon", scope: "application", tool: "discord_set_application_icon" },
          {
            field: "application description",
            scope: "application",
            tool: "discord_set_application_description",
          },
        ],
        not_changeable: [
          {
            field: "bot profile banner",
            reason:
              "Discord exposes a profile banner only on user accounts. A bot token cannot set it; the developer portal offers no field for it either.",
          },
          {
            field: "bot 'about me' / bio",
            reason:
              "Discord exposes a bio on user accounts. Bot accounts have no bio field in the API or the developer portal.",
          },
          {
            field: "bot pronouns / accent colour / avatar decoration",
            reason:
              "These are user-account profile fields. They are absent from the bot API surface.",
          },
          {
            field: "bot discriminator (#0000)",
            reason:
              "Discord removed discriminators for applications; a bot's identity is its username and ID only.",
          },
          {
            field: "guild name and icon via the bot profile tools",
            reason:
              "Those are guild settings, changed with discord_set_guild_name and discord_set_guild_icon. They are intentionally not part of this module.",
          },
        ],
      }),
  }),
];

export default defineModule(tools);
