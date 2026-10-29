import { StickerFormatType } from "discord.js";
import { z } from "zod";
import { assertBotPermission, getGuild, resolveImageInput } from "../client.js";
import { recordAction } from "../safety.js";
import { defineModule, defineTool, guildId, imageInput, snowflake, structured } from "./define.js";

/**
 * Tools for the server's own expression assets: custom emojis and stickers.
 *
 * Both live under the Manage Expressions permission (previously split across
 * Manage Emojis and Stickers). Emoji names are restricted to 2–32 characters of
 * `[A-Za-z0-9_]`, which is a Discord constraint, not a choice made here.
 */

const emojiSummary = z.object({
  id: z.string(),
  name: z.string().nullable(),
  animated: z.boolean(),
  url: z.string(),
  managed: z.boolean(),
  available: z.boolean(),
  role_ids: z.array(z.string()),
  author_id: z.string().nullable(),
});

const stickerSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  tags: z.string(),
  format: z.string(),
  url: z.string(),
  available: z.boolean(),
});

const EMOJI_NAME = /^[A-Za-z0-9_]{2,32}$/;

const tools = [
  defineTool({
    name: "discord_list_emojis",
    description:
      "List every custom emoji in a server with its ID, name, whether it is animated, its image URL, and the roles it is restricted to (empty means usable by everyone). Read-only.",
    annotations: { title: "List emojis", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({ emojis: z.array(emojiSummary) }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      const emojis = await guild.emojis.fetch();
      return structured({
        emojis: [...emojis.values()].map((e) => ({
          id: e.id,
          name: e.name,
          animated: e.animated ?? false,
          url: e.imageURL({ size: 128 }),
          managed: e.managed,
          available: e.available ?? true,
          role_ids: [...e.roles.cache.keys()],
          author_id: e.author?.id ?? null,
        })),
      });
    },
  }),
  defineTool({
    name: "discord_create_emoji",
    description:
      "Upload a new custom emoji to the server. The name must be 2–32 characters using only letters, digits and underscores (Discord's rule). Accepts an https URL, data: URI or base64 image: PNG, JPEG, GIF or WebP, up to 256 KB for emojis. Requires Manage Expressions. Discord also caps the total number of emojis by boost tier, and rejects the upload with a clear error once the cap is reached. Returns the created emoji.",
    annotations: {
      title: "Create emoji",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      name: z
        .string()
        .regex(EMOJI_NAME, "Emoji names are 2–32 characters of letters, digits and underscores.")
        .describe("Emoji name, e.g. 'pepe_happy'. This is the text used in :name:."),
      image: imageInput,
      role_ids: z
        .array(snowflake)
        .optional()
        .describe("Restrict the emoji to these roles. Omit for everyone."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: emojiSummary,
    handle: async ({ guild_id, name, image, role_ids, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageEmojisAndStickers", "creating emojis");
      const buffer = await resolveImageInput(image, "emoji image");
      if (buffer.length > 256 * 1024)
        throw new Error(
          `The emoji image is ${buffer.length} bytes; Discord caps emojis at 256 KB. Resize it first.`,
        );
      const emoji = await guild.emojis.create({
        attachment: buffer,
        name,
        roles: role_ids,
        reason,
      });
      recordAction({
        tool: "discord_create_emoji",
        guildId: guild_id,
        summary: `Created emoji :${name}:`,
        outcome: "applied",
      });
      return structured({
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated ?? false,
        url: emoji.imageURL({ size: 128 }),
        managed: emoji.managed,
        available: emoji.available ?? true,
        role_ids: [...emoji.roles.cache.keys()],
        author_id: emoji.author?.id ?? null,
      });
    },
  }),
  defineTool({
    name: "discord_edit_emoji",
    description:
      "Rename a custom emoji or change which roles may use it. Only provided fields change. Requires Manage Expressions. Passing role_ids replaces the whole restriction list; pass an empty array to open the emoji to everyone. Returns the updated emoji.",
    annotations: {
      title: "Edit emoji",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      emoji_id: snowflake.describe("ID of the emoji to edit."),
      name: z
        .string()
        .regex(EMOJI_NAME, "Emoji names are 2–32 characters of letters, digits and underscores.")
        .optional()
        .describe("New emoji name."),
      role_ids: z
        .array(snowflake)
        .optional()
        .describe("Replacement role restriction list. Empty array means everyone."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: emojiSummary,
    handle: async ({ guild_id, emoji_id, name, role_ids, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageEmojisAndStickers", "editing emojis");
      const emoji = await guild.emojis.fetch(emoji_id);
      if (!emoji) throw new Error(`Emoji ${emoji_id} not found.`);
      const updated = await emoji.edit({ name, roles: role_ids, reason });
      recordAction({
        tool: "discord_edit_emoji",
        guildId: guild_id,
        summary: `Edited emoji ${emoji_id}`,
        outcome: "applied",
      });
      return structured({
        id: updated.id,
        name: updated.name,
        animated: updated.animated ?? false,
        url: updated.imageURL({ size: 128 }),
        managed: updated.managed,
        available: updated.available ?? true,
        role_ids: [...updated.roles.cache.keys()],
        author_id: updated.author?.id ?? null,
      });
    },
  }),
  defineTool({
    name: "discord_delete_emoji",
    description:
      "Delete a custom emoji. IRREVERSIBLE: the image is gone and every message that used :name: shows as an unknown emoji from then on. Requires Manage Expressions. Managed emojis (created by an integration) cannot be deleted by a bot and Discord will reject the call. Returns the deleted emoji's name.",
    annotations: {
      title: "Delete emoji",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      emoji_id: snowflake.describe("ID of the emoji to delete."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({ deleted: z.string(), name: z.string().nullable() }),
    handle: async ({ guild_id, emoji_id, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageEmojisAndStickers", "deleting emojis");
      const emoji = await guild.emojis.fetch(emoji_id);
      if (!emoji) throw new Error(`Emoji ${emoji_id} not found.`);
      if (emoji.managed)
        throw new Error(
          `Emoji ${emoji_id} is managed by an integration and cannot be deleted through the API.`,
        );
      const name = emoji.name;
      await emoji.delete(reason);
      recordAction({
        tool: "discord_delete_emoji",
        guildId: guild_id,
        summary: `Deleted emoji :${name}:`,
        outcome: "applied",
      });
      return structured({ deleted: emoji_id, name });
    },
  }),
  defineTool({
    name: "discord_list_stickers",
    description:
      "List the server's custom stickers with their ID, name, description, tags, format and image URL. Read-only.",
    annotations: { title: "List stickers", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({ stickers: z.array(stickerSummary) }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      const stickers = await guild.stickers.fetch();
      return structured({
        stickers: [...stickers.values()].map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          tags: s.tags,
          format: StickerFormatType[s.format] ?? String(s.format),
          url: s.url,
          available: s.available ?? true,
        })),
      });
    },
  }),
  defineTool({
    name: "discord_create_sticker",
    description:
      "Upload a custom sticker to the server. Discord accepts PNG, APNG and Lottie (JSON) stickers here; GIF stickers are not accepted at upload. The name is 2–30 characters and the tags string is a comma-separated list used for search. Requires Manage Expressions, and Discord caps the sticker count by boost tier. Returns the created sticker.",
    annotations: {
      title: "Create sticker",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      name: z.string().min(2).max(30).describe("Sticker name (2–30 characters)."),
      tags: z.string().min(1).max(200).describe("Comma-separated search tags."),
      description: z.string().max(100).optional().describe("Optional description (max 100 chars)."),
      image: imageInput.describe(
        "Sticker file as an https URL, data: URI or base64 (PNG, APNG or Lottie JSON).",
      ),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: stickerSummary,
    handle: async ({ guild_id, name, tags, description, image, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageEmojisAndStickers", "creating stickers");
      const buffer = await resolveImageInput(image, "sticker image");
      const sticker = await guild.stickers.create({
        file: buffer,
        name,
        tags,
        description,
        reason,
      });
      recordAction({
        tool: "discord_create_sticker",
        guildId: guild_id,
        summary: `Created sticker "${name}"`,
        outcome: "applied",
      });
      return structured({
        id: sticker.id,
        name: sticker.name,
        description: sticker.description,
        tags: sticker.tags,
        format: StickerFormatType[sticker.format] ?? String(sticker.format),
        url: sticker.url,
        available: sticker.available ?? true,
      });
    },
  }),
  defineTool({
    name: "discord_edit_sticker",
    description:
      "Update a custom sticker's name, description or tags. Only provided fields change. Requires Manage Expressions. The image itself cannot be changed: Discord has no endpoint for it, so delete and re-upload to replace the artwork. Returns the updated sticker.",
    annotations: {
      title: "Edit sticker",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      sticker_id: snowflake.describe("ID of the sticker to edit."),
      name: z.string().min(2).max(30).optional().describe("New name (2–30 characters)."),
      description: z
        .string()
        .max(100)
        .nullable()
        .optional()
        .describe("New description, or null to clear."),
      tags: z.string().min(1).max(200).optional().describe("Replacement comma-separated tags."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: stickerSummary,
    handle: async ({ guild_id, sticker_id, name, description, tags, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageEmojisAndStickers", "editing stickers");
      const sticker = await guild.stickers.fetch(sticker_id);
      if (!sticker) throw new Error(`Sticker ${sticker_id} not found.`);
      const updated = await sticker.edit({ name, description, tags, reason });
      recordAction({
        tool: "discord_edit_sticker",
        guildId: guild_id,
        summary: `Edited sticker ${sticker_id}`,
        outcome: "applied",
      });
      return structured({
        id: updated.id,
        name: updated.name,
        description: updated.description,
        tags: updated.tags,
        format: StickerFormatType[updated.format] ?? String(updated.format),
        url: updated.url,
        available: updated.available ?? true,
      });
    },
  }),
  defineTool({
    name: "discord_delete_sticker",
    description:
      "Delete a custom sticker from the server. IRREVERSIBLE: the artwork is gone and messages that used it lose the image. Requires Manage Expressions. Standard (Discord-provided) stickers cannot be deleted; this tool only removes guild stickers. Returns the deleted sticker's name.",
    annotations: {
      title: "Delete sticker",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      sticker_id: snowflake.describe("ID of the sticker to delete."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({ deleted: z.string(), name: z.string() }),
    handle: async ({ guild_id, sticker_id, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageEmojisAndStickers", "deleting stickers");
      const sticker = await guild.stickers.fetch(sticker_id);
      if (!sticker) throw new Error(`Sticker ${sticker_id} not found.`);
      const name = sticker.name;
      await sticker.delete(reason);
      recordAction({
        tool: "discord_delete_sticker",
        guildId: guild_id,
        summary: `Deleted sticker "${name}"`,
        outcome: "applied",
      });
      return structured({ deleted: sticker_id, name });
    },
  }),
];

export default defineModule(tools);
