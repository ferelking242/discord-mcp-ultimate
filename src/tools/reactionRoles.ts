import { z } from "zod";

import { getGuild, getTextChannel } from "../client.js";
import { ReactionRoleStore, normalizeEmoji } from "../bot/reactionRoles.js";
import { recordAction } from "../safety.js";
import { defineModule, defineTool, guildId, snowflake, structured } from "./define.js";

/**
 * Reaction-role menus, driven from the MCP side.
 *
 * The bot process owns the gateway and reacts to events; this module owns the
 * configuration. They meet at one JSON file: a mapping written here is picked up by
 * the running bot within a couple of seconds, so building a menu does not need a
 * bot restart. See `src/bot/` for the event side.
 */

const mapping = z.object({
  guild_id: z.string(),
  channel_id: z.string(),
  message_id: z.string(),
  emoji: z.string(),
  role_id: z.string(),
  label: z.string().nullable(),
  created_at: z.string(),
});

function store(): ReactionRoleStore {
  return new ReactionRoleStore(process.env.BOT_REACTION_ROLES_FILE ?? ".data/reaction-roles.json");
}

/** True when a role sits below the bot's highest role, so it can be granted. */
function roleGrantable(botHighest: number, rolePosition: number): boolean {
  return rolePosition < botHighest;
}

const tools = [
  defineTool({
    name: "discord_create_reaction_role_menu",
    description:
      "Attach one or more emoji→role mappings to a message so members self-assign roles by reacting. Posts a menu embed, adds each reaction, and records the mappings the bot process reads. The bot must be running (`npm run bot`) for reactions to be honoured: this tool only writes the configuration. Roles at or above the bot's highest role are refused before anything is posted, because Discord would reject the grant anyway.",
    annotations: { title: "Create reaction-role menu" },
    schema: z.object({
      guild_id: guildId,
      channel_id: snowflake.describe("Channel the menu is posted in."),
      title: z.string().min(1).max(256).describe("Embed title."),
      description: z
        .string()
        .max(4096)
        .optional()
        .describe("Embed body, e.g. how to use the menu."),
      entries: z
        .array(
          z
            .object({
              emoji: z.string().min(1).describe("A unicode emoji or a server emoji name."),
              role_id: snowflake,
              label: z
                .string()
                .max(100)
                .optional()
                .describe("Shown in the embed, not sent to Discord."),
            })
            .strict(),
        )
        .min(1)
        .max(20)
        .describe("Emoji→role pairs. Discord allows up to 20 reactions per message."),
      reason: z.string().max(512).optional(),
    }),
    outputSchema: z.object({
      message_id: z.string(),
      channel_id: z.string(),
      mappings: z.array(mapping),
      warnings: z.array(z.string()),
    }),
    async handle(args) {
      const guild = await getGuild(args.guild_id);
      const channel = await getTextChannel(args.channel_id);
      const me = guild.members.me;
      if (!me) throw new Error("Bot member is unavailable; is the bot in this guild?");

      const warnings: string[] = [];
      const prepared: { emoji: string; roleId: string; label: string }[] = [];

      for (const entry of args.entries) {
        const role =
          guild.roles.cache.get(entry.role_id) ??
          (await guild.roles.fetch(entry.role_id).catch(() => null));
        if (!role) {
          warnings.push(
            `Skipped ${entry.emoji}: role ${entry.role_id} does not exist in this guild.`,
          );
          continue;
        }
        if (role.managed) {
          warnings.push(
            `Skipped ${entry.emoji}: role "${role.name}" is managed by an integration.`,
          );
          continue;
        }
        if (!roleGrantable(me.roles.highest.position, role.position)) {
          warnings.push(
            `Skipped ${entry.emoji}: role "${role.name}" sits at or above the bot's highest role, so Discord would refuse to grant it.`,
          );
          continue;
        }
        prepared.push({ emoji: entry.emoji, roleId: role.id, label: entry.label ?? role.name });
      }

      if (prepared.length === 0) {
        throw new Error(
          `No usable role in this menu. ${warnings.join(" ")} Move the bot's role above the roles it should hand out.`,
        );
      }

      const { EmbedBuilder } = await import("discord.js");
      const embed = new EmbedBuilder()
        .setTitle(args.title)
        .setColor(0x7c5cff)
        .addFields(
          prepared.map((p) => ({
            name: `${p.emoji}  ${p.label}`,
            value: `<@&${p.roleId}>`,
            inline: true,
          })),
        );
      if (args.description) embed.setDescription(args.description);

      const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });

      const stored = store();
      await stored.load();
      const written: z.infer<typeof mapping>[] = [];
      for (const p of prepared) {
        try {
          await message.react(p.emoji);
        } catch (err) {
          warnings.push(
            `Could not add reaction ${p.emoji}: ${(err as Error).message}. The mapping was not saved for it.`,
          );
          continue;
        }
        const entry = await stored.add({
          guildId: args.guild_id,
          channelId: args.channel_id,
          messageId: message.id,
          emoji: normalizeEmoji(p.emoji),
          roleId: p.roleId,
          label: p.label,
        });
        written.push({
          guild_id: entry.guildId,
          channel_id: entry.channelId,
          message_id: entry.messageId,
          emoji: entry.emoji,
          role_id: entry.roleId,
          label: entry.label ?? null,
          created_at: entry.createdAt,
        });
      }

      recordAction({
        tool: "discord_create_reaction_role_menu",
        guildId: args.guild_id,
        summary: `created reaction-role menu on message ${message.id} with ${written.length} role(s)`,
        outcome: "applied",
      });

      return structured({
        message_id: message.id,
        channel_id: args.channel_id,
        mappings: written,
        warnings,
      });
    },
  }),

  defineTool({
    name: "discord_list_reaction_role_menus",
    description:
      "List the reaction-role mappings on disk, optionally filtered to one guild. These are the mappings the bot process will honour; a mapping whose role or message was deleted is still listed, so check it before trusting it.",
    annotations: { title: "List reaction-role menus", readOnlyHint: true },
    schema: z.object({ guild_id: guildId.optional() }),
    outputSchema: z.object({ count: z.number(), mappings: z.array(mapping) }),
    async handle(args) {
      const stored = store();
      await stored.load();
      const all = stored.all().filter((m) => !args.guild_id || m.guildId === args.guild_id);
      return structured({
        count: all.length,
        mappings: all.map((m) => ({
          guild_id: m.guildId,
          channel_id: m.channelId,
          message_id: m.messageId,
          emoji: m.emoji,
          role_id: m.roleId,
          label: m.label ?? null,
          created_at: m.createdAt,
        })),
      });
    },
  }),

  defineTool({
    name: "discord_delete_reaction_role_menu",
    description:
      "Remove every reaction-role mapping attached to one message. The message itself is left alone. Returns the number of mappings removed, so a call that matched nothing is visible as 0 rather than as success.",
    annotations: { title: "Delete reaction-role menu", destructiveHint: true },
    schema: z.object({
      channel_id: snowflake,
      message_id: snowflake,
      reason: z.string().max(512).optional(),
    }),
    outputSchema: z.object({ removed: z.number(), channel_id: z.string(), message_id: z.string() }),
    async handle(args) {
      const stored = store();
      await stored.load();
      const removed = await stored.removeMessage(args.channel_id, args.message_id);
      recordAction({
        tool: "discord_delete_reaction_role_menu",
        guildId: null,
        summary: `removed ${removed} reaction-role mapping(s) from message ${args.message_id}`,
        outcome: "applied",
      });
      return structured({ removed, channel_id: args.channel_id, message_id: args.message_id });
    },
  }),
];

export default defineModule(tools);
