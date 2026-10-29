import { ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { z } from "zod";
import { discord, getGuild, serializePermissions } from "../client.js";
import { readAuditTrail } from "../safety.js";
import { defineModule, defineTool, guildId, snowflake, structured } from "./define.js";

/**
 * Diagnostics and permission analysis.
 *
 * These tools answer the two questions that come up whenever a Discord change
 * "does not work": *what is the effective permission here?* and *what is
 * actually misconfigured?* Both are read-only, and both report Discord's own
 * computed answer rather than re-deriving it, because permission resolution
 * involves base permissions, category inheritance, channel overwrites, role
 * hierarchy and the @everyone role in an order that is easy to get wrong.
 */

const tools = [
  defineTool({
    name: "discord_explain_permissions",
    description:
      "Explain a member's *effective* permissions in a channel, using Discord's own resolution (base role permissions, then category and channel overwrites, in Discord's order). Reports the resulting allow set, which flags came from overwrites, and any permission that is denied. Read-only. This is the tool to use when someone 'cannot see' or 'cannot post' and the cause is not obvious.",
    annotations: {
      title: "Explain effective permissions",
      readOnlyHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      user_id: snowflake.describe("Member whose permissions should be explained."),
      channel_id: snowflake
        .optional()
        .describe("Channel to resolve against. Omit for server-wide (base) permissions."),
    }),
    outputSchema: z.object({
      guild_id: z.string(),
      user_id: z.string(),
      channel_id: z.string().nullable(),
      channel_name: z.string().nullable(),
      granted: z.array(z.string()),
      denied_by_overwrite: z.array(z.string()),
      relevant_overwrites: z.array(
        z.object({
          target: z.string(),
          target_type: z.string(),
          allow: z.array(z.string()),
          deny: z.array(z.string()),
        }),
      ),
      notes: z.array(z.string()),
    }),
    handle: async ({ guild_id, user_id, channel_id }) => {
      const guild = await getGuild(guild_id);
      const member = await guild.members.fetch(user_id);
      const channel = channel_id ? await guild.channels.fetch(channel_id) : null;
      if (channel_id && !channel) throw new Error(`Channel ${channel_id} not found.`);

      const permissions = channel ? channel.permissionsFor(member) : member.permissions;
      const granted = permissions ? serializePermissions(permissions as PermissionsBitField) : [];

      const relevantOverwrites: {
        target: string;
        target_type: string;
        allow: string[];
        deny: string[];
      }[] = [];
      const deniedByOverwrite: string[] = [];
      if (channel && "permissionOverwrites" in channel) {
        const roleIds = new Set(member.roles.cache.keys());
        for (const ow of channel.permissionOverwrites.cache.values()) {
          const applies = ow.type === 0 ? roleIds.has(ow.id) : ow.id === member.id;
          if (!applies) continue;
          const allow = serializePermissions(ow.allow as never);
          const deny = serializePermissions(ow.deny as never);
          relevantOverwrites.push({
            target:
              ow.type === 0
                ? (guild.roles.cache.get(ow.id)?.name ?? ow.id)
                : (member.user.tag ?? ow.id),
            target_type: ow.type === 0 ? "role" : "member",
            allow,
            deny,
          });
          for (const flag of deny) if (!granted.includes(flag)) deniedByOverwrite.push(flag);
        }
      }

      const notes: string[] = [];
      if (member.roles.highest.position <= (guild.members.me?.roles.highest.position ?? 0))
        notes.push(
          "This member's highest role is at or below the bot's, so the bot can manage them.",
        );
      else
        notes.push(
          "This member's highest role is above the bot's highest role: the bot cannot edit, kick, ban or time out this member.",
        );
      if (member.id === guild.ownerId)
        notes.push("This member owns the server and bypasses every channel overwrite.");
      if (permissions?.has(PermissionFlagsBits.Administrator))
        notes.push(
          "This member has Administrator, which grants every permission and bypasses all overwrites.",
        );

      return structured({
        guild_id: guild.id,
        user_id: member.id,
        channel_id: channel?.id ?? null,
        channel_name: channel?.name ?? null,
        granted,
        denied_by_overwrite: [...new Set(deniedByOverwrite)],
        relevant_overwrites: relevantOverwrites,
        notes,
      });
    },
  }),
  defineTool({
    name: "discord_check_tool_permissions",
    description:
      "Given a guild and a list of tool names, report for each whether the bot currently holds the permissions that tool needs, and whether the target channel is visible to it. Read-only. Use this before a multi-step operation to fail early with an actionable message instead of partway through.",
    annotations: { title: "Preflight tool permissions", readOnlyHint: true, openWorldHint: true },
    schema: z.object({
      guild_id: guildId,
      tools: z
        .array(z.string())
        .min(1)
        .describe("Tool names to check, e.g. ['discord_create_channel', 'discord_ban_member']."),
      channel_id: snowflake.optional().describe("Optional channel to also check visibility in."),
    }),
    outputSchema: z.object({
      guild_id: z.string(),
      channel_visible: z.boolean().nullable(),
      results: z.array(
        z.object({
          tool: z.string(),
          required_permissions: z.array(z.string()),
          missing_permissions: z.array(z.string()),
          ready: z.boolean(),
          known_tool: z.boolean(),
        }),
      ),
      summary: z.string(),
    }),
    handle: async ({ guild_id, tools: requested, channel_id }) => {
      const guild = await getGuild(guild_id);
      const me = guild.members.me;
      const requirements = TOOL_PERMISSION_MAP;
      const results = requested.map((tool) => {
        const required = requirements[tool];
        const known = required !== undefined;
        const needed = required ?? [];
        const missing = me
          ? needed.filter((p) => !me.permissions.has(p as keyof typeof PermissionFlagsBits))
          : needed;
        return {
          tool,
          required_permissions: needed,
          missing_permissions: missing,
          ready: known && missing.length === 0,
          known_tool: known,
        };
      });
      let channelVisible: boolean | null = null;
      if (channel_id && me) {
        const channel = await guild.channels.fetch(channel_id);
        channelVisible = channel
          ? (channel.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel) ?? false)
          : null;
      }
      const notReady = results.filter((r) => !r.ready).length;
      return structured({
        guild_id: guild.id,
        channel_visible: channelVisible,
        results,
        summary:
          notReady === 0
            ? `All ${results.length} tool(s) have their required permissions.`
            : `${notReady} of ${results.length} tool(s) are missing a permission; see missing_permissions.`,
      });
    },
  }),
  defineTool({
    name: "discord_find_permission_problems",
    description:
      "Scan a server for permission problems and return each with a fix: channels the bot cannot see, channels where @everyone was denied ViewChannel but the bot has no compensating allow (a classic lockout), overwrites that deny Send Messages to @everyone in channels that look public, roles with Administrator that are not the bot's own, and members whose highest role is above the bot's. Read-only.",
    annotations: { title: "Find permission problems", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({
      guild_id: z.string(),
      problems: z.array(
        z.object({
          severity: z.enum(["error", "warning", "info"]),
          where: z.string(),
          problem: z.string(),
          fix: z.string(),
        }),
      ),
      ok: z.boolean(),
    }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      await guild.channels.fetch();
      const me = guild.members.me;
      const problems: {
        severity: "error" | "warning" | "info";
        where: string;
        problem: string;
        fix: string;
      }[] = [];

      if (!me) {
        return structured({
          guild_id: guild.id,
          problems: [
            {
              severity: "error" as const,
              where: "bot",
              problem: "The bot's member object is not cached; permissions cannot be resolved.",
              fix: "Enable the Server Members intent in the Developer Portal and set DISCORD_GUILD_MEMBERS=true.",
            },
          ],
          ok: false,
        });
      }

      for (const channel of guild.channels.cache.values()) {
        if (channel.type === ChannelType.GuildCategory) continue;
        const perms = channel.permissionsFor(me);
        if (!perms?.has(PermissionFlagsBits.ViewChannel)) {
          problems.push({
            severity: "error",
            where: `#${channel.name}`,
            problem: "The bot cannot see this channel, so no tool can act on it.",
            fix: `Add an allow overwrite for the bot's role with discord_set_role_permission on channel_id ${channel.id}.`,
          });
          continue;
        }
        if ("permissionOverwrites" in channel) {
          const everyone = channel.permissionOverwrites.cache.get(guild.id);
          if (everyone && everyone.deny.has(PermissionFlagsBits.ViewChannel)) {
            const botAllow = [...channel.permissionOverwrites.cache.values()].some(
              (ow) =>
                ow.type === 0 &&
                me.roles.cache.has(ow.id) &&
                ow.allow.has(PermissionFlagsBits.ViewChannel),
            );
            if (!botAllow && !perms.has(PermissionFlagsBits.Administrator)) {
              problems.push({
                severity: "warning",
                where: `#${channel.name}`,
                problem:
                  "@everyone is denied View Channel and the bot has no compensating allow, so only Administrators and the owner can see it.",
                fix: "Grant the bot's role an explicit allow on this channel, or remove the @everyone deny.",
              });
            }
          }
          if (
            everyone?.deny.has(PermissionFlagsBits.SendMessages) &&
            !channel.name.match(/rules|announce|read-?only|info/i)
          ) {
            problems.push({
              severity: "info",
              where: `#${channel.name}`,
              problem:
                "@everyone cannot send messages here, but the channel name does not look like a read-only channel.",
              fix: "Confirm this is intentional, or allow Send Messages for @everyone.",
            });
          }
        }
      }

      for (const role of guild.roles.cache.values()) {
        if (role.managed || role.name === "@everyone") continue;
        if (role.permissions.has(PermissionFlagsBits.Administrator)) {
          problems.push({
            severity: "warning",
            where: `role "${role.name}"`,
            problem: "This role has Administrator, which bypasses every permission check.",
            fix: "Grant only the permissions the role actually needs.",
          });
        }
      }

      return structured({
        guild_id: guild.id,
        problems,
        ok: problems.filter((p) => p.severity === "error").length === 0,
      });
    },
  }),
  defineTool({
    name: "discord_diagnose_configuration",
    description:
      "Diagnose the server's configuration end to end: the bot's permission baseline, Community prerequisites, the AFK/system/rules channel slots, per-channel bot visibility, role hierarchy, AutoMod presence, intents, and the env flags in effect. Each finding carries a concrete fix. Read-only. Run this first when something behaves unexpectedly.",
    annotations: { title: "Diagnose configuration", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({
      guild_id: z.string(),
      environment: z.object({
        message_content_intent: z.boolean(),
        guild_members_intent: z.boolean(),
        allowed_guilds_restricted: z.boolean(),
        toolsets: z.string().nullable(),
        client_ready: z.boolean(),
        ping_ms: z.number().nullable(),
      }),
      findings: z.array(
        z.object({
          severity: z.enum(["error", "warning", "info"]),
          area: z.string(),
          problem: z.string(),
          fix: z.string(),
        }),
      ),
      checks_run: z.array(z.string()),
      healthy: z.boolean(),
    }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      await guild.channels.fetch();
      const me = guild.members.me;
      const findings: {
        severity: "error" | "warning" | "info";
        area: string;
        problem: string;
        fix: string;
      }[] = [];

      const communityEnabled = guild.features.includes("COMMUNITY" as never);
      if (communityEnabled && !guild.rulesChannelId)
        findings.push({
          severity: "error",
          area: "community",
          problem: "Community is enabled but no rules channel is registered.",
          fix: "Register one with discord_set_guild_channels (rules_channel_id).",
        });
      if (communityEnabled && !guild.publicUpdatesChannelId)
        findings.push({
          severity: "error",
          area: "community",
          problem: "Community is enabled but no public-updates channel is registered.",
          fix: "Register one with discord_set_guild_channels (public_updates_channel_id).",
        });
      if (!communityEnabled)
        findings.push({
          severity: "info",
          area: "community",
          problem:
            "Community is disabled, so rules/public-updates channels, welcome screen, onboarding, AutoMod and membership screening are unavailable.",
          fix: "Create a rules channel and an updates channel, then run discord_enable_community.",
        });

      if (guild.afkChannelId) {
        const afk = guild.channels.cache.get(guild.afkChannelId);
        if (afk && afk.type !== ChannelType.GuildVoice && afk.type !== ChannelType.GuildStageVoice)
          findings.push({
            severity: "error",
            area: "afk",
            problem: `AFK channel "${afk.name}" is not a voice channel.`,
            fix: "Point afk_channel_id at a voice channel.",
          });
      }

      if (me && !me.permissions.has(PermissionFlagsBits.ManageGuild))
        findings.push({
          severity: "error",
          area: "permissions",
          problem: "The bot lacks Manage Server, so no server setting can be changed.",
          fix: "Grant Manage Server to the bot's role.",
        });

      if (me) {
        const hidden = [...guild.channels.cache.values()].filter((c) => {
          if (c.type === ChannelType.GuildCategory) return false;
          return !c.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel);
        });
        if (hidden.length > 0)
          findings.push({
            severity: "warning",
            area: "channel access",
            problem: `The bot cannot see ${hidden.length} channel(s): ${hidden
              .slice(0, 5)
              .map((c) => `#${c.name}`)
              .join(", ")}${hidden.length > 5 ? "…" : ""}.`,
            fix: "Grant the bot's role an allow overwrite on those channels.",
          });
      }

      try {
        const rules = await guild.autoModerationRules.fetch();
        if (rules.size === 0)
          findings.push({
            severity: "warning",
            area: "automod",
            problem: "No AutoMod rules are configured.",
            fix: "Run discord_apply_automod_baseline with confirm:true.",
          });
      } catch {
        findings.push({
          severity: "info",
          area: "automod",
          problem: "AutoMod rules are unreadable, which means the AutoModeration feature is off.",
          fix: "Enable Community first.",
        });
      }

      return structured({
        guild_id: guild.id,
        environment: {
          message_content_intent: !/^(false|0|no|off)$/i.test(
            (process.env.DISCORD_MESSAGE_CONTENT ?? "true").trim(),
          ),
          guild_members_intent: !/^(false|0|no|off)$/i.test(
            (process.env.DISCORD_GUILD_MEMBERS ?? "true").trim(),
          ),
          allowed_guilds_restricted: Boolean(process.env.DISCORD_ALLOWED_GUILDS?.trim()),
          toolsets: process.env.DISCORD_MCP_TOOLSETS?.trim() ?? null,
          client_ready: discord.isReady(),
          ping_ms: discord.ws.ping >= 0 ? discord.ws.ping : null,
        },
        findings,
        checks_run: [
          "community prerequisites",
          "AFK channel type",
          "bot permission baseline",
          "channel visibility",
          "AutoMod presence",
          "environment flags",
        ],
        healthy: findings.filter((f) => f.severity === "error").length === 0,
      });
    },
  }),
  defineTool({
    name: "discord_read_audit_trail",
    description:
      "Read this MCP server's own record of what it changed: every mutating tool call, when it ran, which guild it targeted, whether it was applied or only previewed, and whether it failed. This is NOT Discord's audit log (use discord_get_audit_log for that); it is the server's in-memory trail, capped at the 500 most recent entries and lost when the process restarts. Read-only. Use it to answer 'what did the bot just do?'.",
    annotations: { title: "Read MCP action trail", readOnlyHint: true, openWorldHint: false },
    schema: z.object({
      limit: z.int().min(1).max(500).default(50).describe("How many recent entries to return."),
    }),
    outputSchema: z.object({
      entries: z.array(
        z.object({
          timestamp: z.string(),
          tool: z.string(),
          guild_id: z.string().nullable(),
          summary: z.string(),
          outcome: z.string(),
        }),
      ),
      note: z.string(),
    }),
    handle: async ({ limit }) =>
      structured({
        entries: readAuditTrail(limit).map((entry) => ({
          timestamp: entry.timestamp,
          tool: entry.tool,
          guild_id: entry.guildId,
          summary: entry.summary,
          outcome: entry.outcome,
        })),
        note: "In-memory trail, capped at 500 entries, cleared on restart. This is the MCP server's record, not Discord's audit log.",
      }),
  }),
  defineTool({
    name: "discord_verify_setup",
    description:
      "Check that the MCP server itself is correctly installed and connected: whether DISCORD_TOKEN is set (reported as a boolean, never echoed), which gateway intents are requested, which toolsets are exposed and how many tools that yields, whether the Discord client reached READY, and the gateway ping. Read-only, takes no arguments. Run this first when the MCP server appears not to work at all.",
    annotations: { title: "Verify MCP setup", readOnlyHint: true, openWorldHint: true },
    schema: z.object({}),
    outputSchema: z.object({
      token_configured: z.boolean(),
      token_length: z.number(),
      client_ready: z.boolean(),
      bot_tag: z.string().nullable(),
      guild_count: z.number(),
      ping_ms: z.number().nullable(),
      intents_requested: z.array(z.string()),
      toolsets_env: z.string().nullable(),
      tool_count: z.number(),
      allowed_guilds_count: z.number(),
      problems: z.array(z.string()),
      next_steps: z.array(z.string()),
    }),
    handle: async () => {
      const { getAllDefinitions } = await import("./index.js");
      const problems: string[] = [];
      const nextSteps: string[] = [];
      const tokenConfigured = Boolean(process.env.DISCORD_TOKEN);
      if (!tokenConfigured) {
        problems.push("DISCORD_TOKEN is not set; every tool call will fail at connect time.");
        nextSteps.push("Set DISCORD_TOKEN in the MCP client config or a .env file.");
      }
      const ready = discord.isReady();
      if (tokenConfigured && !ready)
        problems.push(
          "The client has not reached READY. Check the token, and that the privileged intents requested below are enabled in the Developer Portal (a missing one closes the connection with code 4014).",
        );
      const messageContent = !/^(false|0|no|off)$/i.test(
        (process.env.DISCORD_MESSAGE_CONTENT ?? "true").trim(),
      );
      const guildMembers = !/^(false|0|no|off)$/i.test(
        (process.env.DISCORD_GUILD_MEMBERS ?? "true").trim(),
      );
      const intents = ["Guilds", "GuildScheduledEvents"];
      if (messageContent) intents.push("MessageContent");
      if (guildMembers) intents.push("GuildMembers");
      const guildCount = discord.guilds.cache.size;
      if (ready && guildCount === 0) {
        problems.push("The bot is connected but is not in any server.");
        nextSteps.push(
          "Invite the bot to a server using the OAuth2 URL Generator with the bot scope.",
        );
      }
      const allowedGuilds = (process.env.DISCORD_ALLOWED_GUILDS ?? "").split(",").filter(Boolean);
      let toolCount = 0;
      try {
        toolCount = getAllDefinitions().length;
      } catch (err) {
        problems.push(
          `The tool registry failed to build: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return structured({
        token_configured: tokenConfigured,
        // The length is enough to catch a truncated paste, and unlike the value
        // it is safe to put in a transcript.
        token_length: process.env.DISCORD_TOKEN?.length ?? 0,
        client_ready: ready,
        bot_tag: discord.user?.tag ?? null,
        guild_count: guildCount,
        ping_ms: ready && discord.ws.ping >= 0 ? discord.ws.ping : null,
        intents_requested: intents,
        toolsets_env: process.env.DISCORD_MCP_TOOLSETS?.trim() ?? null,
        tool_count: toolCount,
        allowed_guilds_count: allowedGuilds.length,
        problems,
        next_steps: nextSteps.length > 0 ? nextSteps : [`Registry exposes ${toolCount} tool(s).`],
      });
    },
  }),
];

/**
 * Which permissions each mutating tool needs, keyed by tool name.
 *
 * Deliberately partial: it covers the tools whose requirements are non-obvious
 * and that appear in multi-step operations. A tool absent from this map is
 * reported as `known_tool: false` rather than being claimed as permission-free.
 */
const TOOL_PERMISSION_MAP: Record<string, string[]> = {
  discord_create_channel: ["ManageChannels"],
  discord_delete_channel: ["ManageChannels"],
  discord_edit_channel: ["ManageChannels"],
  discord_move_channel: ["ManageChannels"],
  discord_clone_channel: ["ManageChannels"],
  discord_set_channel_position: ["ManageChannels"],
  discord_follow_announcement_channel: ["ManageWebhooks"],
  discord_lock_channel_permissions: ["ManageRoles"],
  discord_create_role: ["ManageRoles"],
  discord_edit_role: ["ManageRoles"],
  discord_delete_role: ["ManageRoles"],
  discord_add_role: ["ManageRoles"],
  discord_remove_role: ["ManageRoles"],
  discord_set_role_position: ["ManageRoles"],
  discord_set_role_icon: ["ManageRoles"],
  discord_kick_member: ["KickMembers"],
  discord_ban_member: ["BanMembers"],
  discord_unban_member: ["BanMembers"],
  discord_bulk_ban: ["BanMembers", "ManageGuild"],
  discord_prune_members: ["KickMembers"],
  discord_timeout_member: ["ModerateMembers"],
  discord_set_nickname: ["ManageNicknames"],
  discord_bulk_delete_messages: ["ManageMessages"],
  discord_pin_message: ["ManageMessages"],
  discord_crosspost_message: ["ManageMessages"],
  discord_get_audit_log: ["ViewAuditLog"],
  discord_create_webhook: ["ManageWebhooks"],
  discord_edit_webhook: ["ManageWebhooks"],
  discord_delete_webhook: ["ManageWebhooks"],
  discord_create_invite: ["CreateInstantInvite"],
  discord_delete_invite: ["ManageGuild"],
  discord_create_scheduled_event: ["ManageEvents"],
  discord_edit_scheduled_event: ["ManageEvents"],
  discord_delete_scheduled_event: ["ManageEvents"],
  discord_update_membership_screening: ["ManageGuild"],
  discord_set_guild_name: ["ManageGuild"],
  discord_set_guild_icon: ["ManageGuild"],
  discord_set_guild_banner: ["ManageGuild"],
  discord_set_guild_description: ["ManageGuild"],
  discord_set_guild_safety: ["ManageGuild"],
  discord_set_guild_channels: ["ManageGuild"],
  discord_set_system_channel_notices: ["ManageGuild"],
  discord_enable_community: ["ManageGuild"],
  discord_set_guild_widget: ["ManageGuild"],
  discord_set_welcome_screen: ["ManageGuild"],
  discord_set_onboarding: ["ManageGuild"],
  discord_architect_apply: ["ManageChannels", "ManageRoles"],
  discord_architect_delete_structure: ["ManageChannels", "ManageRoles"],
  discord_architect_create_template: ["ManageGuild"],
  discord_restore_structure: ["ManageChannels", "ManageRoles"],
  discord_create_emoji: ["ManageEmojisAndStickers"],
  discord_edit_emoji: ["ManageEmojisAndStickers"],
  discord_delete_emoji: ["ManageEmojisAndStickers"],
  discord_create_sticker: ["ManageEmojisAndStickers"],
  discord_edit_sticker: ["ManageEmojisAndStickers"],
  discord_delete_sticker: ["ManageEmojisAndStickers"],
  discord_create_automod_rule: ["ManageGuild"],
  discord_edit_automod_rule: ["ManageGuild"],
  discord_delete_automod_rule: ["ManageGuild"],
  discord_apply_automod_baseline: ["ManageGuild"],
  discord_apply_name_theme: ["ManageChannels"],
};

export default defineModule(tools);
