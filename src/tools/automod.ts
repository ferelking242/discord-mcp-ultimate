import {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleKeywordPresetType,
  AutoModerationRuleTriggerType,
} from "discord.js";
import { z } from "zod";
import { assertBotPermission, getGuild } from "../client.js";
import { recordAction } from "../safety.js";
import { defineModule, defineTool, guildId, snowflake, structured } from "./define.js";

/** Keyword presets Discord ships, mapped to readable names. */
const PRESET_NAMES: Record<string, AutoModerationRuleKeywordPresetType> = {
  profanity: AutoModerationRuleKeywordPresetType.Profanity,
  sexual_content: AutoModerationRuleKeywordPresetType.SexualContent,
  slurs: AutoModerationRuleKeywordPresetType.Slurs,
};

const TRIGGER_NAMES: Record<string, AutoModerationRuleTriggerType> = {
  keyword: AutoModerationRuleTriggerType.Keyword,
  spam: AutoModerationRuleTriggerType.Spam,
  keyword_preset: AutoModerationRuleTriggerType.KeywordPreset,
  mention_spam: AutoModerationRuleTriggerType.MentionSpam,
  member_profile: AutoModerationRuleTriggerType.MemberProfile,
};

const EVENT_NAMES: Record<string, AutoModerationRuleEventType> = {
  message_send: AutoModerationRuleEventType.MessageSend,
  member_update: AutoModerationRuleEventType.MemberUpdate,
};

const ACTION_NAMES: Record<string, AutoModerationActionType> = {
  block_message: AutoModerationActionType.BlockMessage,
  send_alert_message: AutoModerationActionType.SendAlertMessage,
  timeout: AutoModerationActionType.Timeout,
  block_member_interaction: AutoModerationActionType.BlockMemberInteraction,
};

const ruleSummary = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  trigger_type: z.string(),
  event_type: z.string(),
  keywords: z.array(z.string()),
  regex_patterns: z.array(z.string()),
  presets: z.array(z.string()),
  allow_list: z.array(z.string()),
  mention_total_limit: z.number().nullable(),
  mention_raid_protection: z.boolean(),
  exempt_role_ids: z.array(z.string()),
  exempt_channel_ids: z.array(z.string()),
  actions: z.array(
    z.object({
      type: z.string(),
      channel_id: z.string().nullable(),
      duration_seconds: z.number().nullable(),
    }),
  ),
  creator_id: z.string().nullable(),
});

/** Serialises an AutoMod rule into a stable, model-friendly shape. */
function describeRule(rule: {
  id: string;
  name: string;
  enabled: boolean;
  triggerType: number;
  eventType: number;
  triggerMetadata: {
    keywordFilter: readonly string[];
    regexPatterns: readonly string[];
    presets: readonly number[];
    allowList: readonly string[];
    mentionTotalLimit: number | null;
    mentionRaidProtectionEnabled: boolean;
  };
  exemptRoles: { keys(): IterableIterator<string> };
  exemptChannels: { keys(): IterableIterator<string> };
  actions: readonly {
    type: number;
    metadata: { channelId: string | null; durationSeconds: number | null };
  }[];
  creatorId: string | null;
}) {
  const nameOf = (table: Record<string, number>, value: number) =>
    Object.entries(table).find(([, v]) => v === value)?.[0] ?? String(value);
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    trigger_type: nameOf(TRIGGER_NAMES, rule.triggerType),
    event_type: nameOf(EVENT_NAMES, rule.eventType),
    keywords: [...rule.triggerMetadata.keywordFilter],
    regex_patterns: [...rule.triggerMetadata.regexPatterns],
    presets: [...rule.triggerMetadata.presets].map((p) => nameOf(PRESET_NAMES, p)),
    allow_list: [...rule.triggerMetadata.allowList],
    mention_total_limit: rule.triggerMetadata.mentionTotalLimit,
    mention_raid_protection: rule.triggerMetadata.mentionRaidProtectionEnabled,
    exempt_role_ids: [...rule.exemptRoles.keys()],
    exempt_channel_ids: [...rule.exemptChannels.keys()],
    actions: rule.actions.map((action) => ({
      type: nameOf(ACTION_NAMES, action.type),
      channel_id: action.metadata.channelId,
      duration_seconds: action.metadata.durationSeconds,
    })),
    creator_id: rule.creatorId,
  };
}

const actionSchema = z.strictObject({
  type: z
    .enum(["block_message", "send_alert_message", "timeout", "block_member_interaction"])
    .describe("What to do when the rule matches."),
  channel_id: snowflake
    .optional()
    .describe("Channel for 'send_alert_message': where the alert is posted."),
  duration_seconds: z
    .int()
    .min(1)
    .max(2_419_200)
    .optional()
    .describe("Timeout duration in seconds for the 'timeout' action (max 28 days)."),
  custom_message: z
    .string()
    .max(150)
    .optional()
    .describe("Message shown to the blocked member (max 150 characters)."),
});

/** Tool definitions for AutoMod rule management. */
const tools = [
  defineTool({
    name: "discord_list_automod_rules",
    description:
      "List every AutoMod rule in a server: its name, enabled state, trigger type and event type, the keyword/regex/preset lists, the allow list, mention limits, exempt roles and channels, and the configured actions. Requires the Manage Server permission (Discord gates the AutoMod endpoints on it). Read-only. Use discord_get_automod_rule for one rule.",
    annotations: { title: "List AutoMod rules", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({ rules: z.array(ruleSummary) }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      const rules = await guild.autoModerationRules.fetch();
      return structured({ rules: [...rules.values()].map((r) => describeRule(r as never)) });
    },
  }),
  defineTool({
    name: "discord_get_automod_rule",
    description:
      "Fetch one AutoMod rule by ID with its full trigger configuration and actions. Requires Manage Server. Read-only.",
    annotations: { title: "Get AutoMod rule", readOnlyHint: true, openWorldHint: true },
    schema: z.object({
      guild_id: guildId,
      rule_id: snowflake.describe("ID of the AutoMod rule."),
    }),
    outputSchema: ruleSummary,
    handle: async ({ guild_id, rule_id }) => {
      const guild = await getGuild(guild_id);
      const rule = await guild.autoModerationRules.fetch(rule_id);
      if (!rule) throw new Error(`AutoMod rule ${rule_id} not found.`);
      return structured(describeRule(rule as never));
    },
  }),
  defineTool({
    name: "discord_create_automod_rule",
    description:
      "Create an AutoMod rule. Requires Manage Server (Discord gates AutoMod on it) and the server to have the AutoModeration feature, which arrives with Community. Trigger types: 'keyword' (keyword_filter + optional regex_patterns), 'keyword_preset' (Discord's built-in profanity/sexual_content/slurs lists), 'spam', 'mention_spam' (mention_total_limit), 'member_profile' (blocks suspicious profile text). Actions: block_message, send_alert_message (needs channel_id), timeout (needs duration_seconds), block_member_interaction. Returns the created rule.",
    annotations: {
      title: "Create AutoMod rule",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      name: z.string().min(1).max(100).describe("Rule name shown in Server Settings."),
      event_type: z
        .enum(["message_send", "member_update"])
        .default("message_send")
        .describe("Which gateway event the rule watches."),
      trigger_type: z
        .enum(["keyword", "spam", "keyword_preset", "mention_spam", "member_profile"])
        .describe("What triggers the rule."),
      keywords: z
        .array(z.string())
        .max(1000)
        .optional()
        .describe("Keywords to match (keyword trigger). Max 1000, each up to 60 characters."),
      regex_patterns: z
        .array(z.string())
        .max(10)
        .optional()
        .describe("Regular expressions to match (keyword trigger). Max 10."),
      presets: z
        .array(z.enum(["profanity", "sexual_content", "slurs"]))
        .optional()
        .describe("Discord's built-in keyword lists (keyword_preset trigger)."),
      allow_list: z
        .array(z.string())
        .max(100)
        .optional()
        .describe("Words that are exempt from the keyword filter. Max 100."),
      mention_total_limit: z
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe(
          "Unique mentions allowed per message before the rule fires (mention_spam trigger).",
        ),
      mention_raid_protection: z
        .boolean()
        .optional()
        .describe("Also block messages that mention a role or exceed the limit."),
      actions: z.array(actionSchema).min(1).describe("Actions to take on a match."),
      enabled: z.boolean().default(true).describe("Whether the rule is active on creation."),
      exempt_role_ids: z.array(snowflake).optional().describe("Roles exempt from the rule."),
      exempt_channel_ids: z.array(snowflake).optional().describe("Channels exempt from the rule."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: ruleSummary,
    handle: async (args) => {
      const guild = await getGuild(args.guild_id);
      assertBotPermission(guild, "ManageGuild", "creating AutoMod rules");
      const rule = await guild.autoModerationRules.create({
        name: args.name,
        eventType: EVENT_NAMES[args.event_type],
        triggerType: TRIGGER_NAMES[args.trigger_type],
        triggerMetadata: {
          keywordFilter: args.keywords,
          regexPatterns: args.regex_patterns,
          presets: args.presets?.map((p) => PRESET_NAMES[p]),
          allowList: args.allow_list,
          mentionTotalLimit: args.mention_total_limit,
          mentionRaidProtectionEnabled: args.mention_raid_protection,
        },
        actions: args.actions.map((action) => ({
          type: ACTION_NAMES[action.type],
          metadata: {
            channel: action.channel_id,
            durationSeconds: action.duration_seconds,
            customMessage: action.custom_message,
          },
        })),
        enabled: args.enabled,
        exemptRoles: args.exempt_role_ids,
        exemptChannels: args.exempt_channel_ids,
        reason: args.reason,
      });
      recordAction({
        tool: "discord_create_automod_rule",
        guildId: args.guild_id,
        summary: `Created AutoMod rule "${args.name}"`,
        outcome: "applied",
      });
      return structured(describeRule(rule as never));
    },
  }),
  defineTool({
    name: "discord_edit_automod_rule",
    description:
      "Update an AutoMod rule: rename it, enable or disable it, replace its trigger metadata or actions, or change its exemptions. Only provided fields change; trigger_type cannot be changed after creation (Discord does not allow it), so delete and recreate to switch trigger type. Requires Manage Server. Returns the updated rule.",
    annotations: {
      title: "Edit AutoMod rule",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      rule_id: snowflake.describe("ID of the AutoMod rule to edit."),
      name: z.string().min(1).max(100).optional().describe("New rule name."),
      enabled: z.boolean().optional().describe("Enable or disable the rule."),
      keywords: z.array(z.string()).max(1000).optional().describe("Replacement keyword list."),
      regex_patterns: z.array(z.string()).max(10).optional().describe("Replacement regex list."),
      presets: z
        .array(z.enum(["profanity", "sexual_content", "slurs"]))
        .optional()
        .describe("Replacement preset list."),
      allow_list: z.array(z.string()).max(100).optional().describe("Replacement allow list."),
      mention_total_limit: z.int().min(1).max(50).optional().describe("New mention limit."),
      mention_raid_protection: z.boolean().optional().describe("Toggle mention raid protection."),
      actions: z.array(actionSchema).min(1).optional().describe("Replacement action list."),
      exempt_role_ids: z.array(snowflake).optional().describe("Replacement exempt roles."),
      exempt_channel_ids: z.array(snowflake).optional().describe("Replacement exempt channels."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: ruleSummary,
    handle: async (args) => {
      const guild = await getGuild(args.guild_id);
      assertBotPermission(guild, "ManageGuild", "editing AutoMod rules");
      const rule = await guild.autoModerationRules.edit(args.rule_id, {
        name: args.name,
        enabled: args.enabled,
        triggerMetadata: {
          keywordFilter: args.keywords,
          regexPatterns: args.regex_patterns,
          presets: args.presets?.map((p) => PRESET_NAMES[p]),
          allowList: args.allow_list,
          mentionTotalLimit: args.mention_total_limit,
          mentionRaidProtectionEnabled: args.mention_raid_protection,
        },
        actions: args.actions?.map((action) => ({
          type: ACTION_NAMES[action.type],
          metadata: {
            channel: action.channel_id,
            durationSeconds: action.duration_seconds,
            customMessage: action.custom_message,
          },
        })),
        exemptRoles: args.exempt_role_ids,
        exemptChannels: args.exempt_channel_ids,
        reason: args.reason,
      });
      recordAction({
        tool: "discord_edit_automod_rule",
        guildId: args.guild_id,
        summary: `Edited AutoMod rule ${args.rule_id}`,
        outcome: "applied",
      });
      return structured(describeRule(rule as never));
    },
  }),
  defineTool({
    name: "discord_delete_automod_rule",
    description:
      "Delete an AutoMod rule. IRREVERSIBLE: the rule and its configuration are gone. Requires Manage Server. There is no preview: deleting an AutoMod rule cannot lose member data, and Discord does not offer an undo, so the tool reports exactly which rule was removed.",
    annotations: {
      title: "Delete AutoMod rule",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      rule_id: snowflake.describe("ID of the AutoMod rule to delete."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({ deleted: z.string(), name: z.string() }),
    handle: async ({ guild_id, rule_id, reason }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "deleting AutoMod rules");
      const rule = await guild.autoModerationRules.fetch(rule_id);
      if (!rule) throw new Error(`AutoMod rule ${rule_id} not found.`);
      const name = rule.name;
      await rule.delete(reason);
      recordAction({
        tool: "discord_delete_automod_rule",
        guildId: guild_id,
        summary: `Deleted AutoMod rule "${name}"`,
        outcome: "applied",
      });
      return structured({ deleted: rule_id, name });
    },
  }),
  defineTool({
    name: "discord_apply_automod_baseline",
    description:
      "Create a sensible baseline of AutoMod rules for a community server in one call: block Discord invite links, block common scam/phishing keywords, block mention spam, and time out repeat offenders. PREVIEWS BY DEFAULT: returns the rules that would be created without creating them; re-call with confirm:true to apply. Rules that already exist by name are skipped, so re-running is safe. Requires Manage Server and the AutoModeration feature (Community).",
    annotations: {
      title: "Apply AutoMod baseline",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      alert_channel_id: snowflake
        .optional()
        .describe("Channel for the 'send_alert_message' action. Omit for block-only rules."),
      confirm: z
        .boolean()
        .default(false)
        .describe("Set true to actually create the rules. Default false returns a preview."),
    }),
    outputSchema: z.object({
      mode: z.string(),
      planned: z.array(z.string()),
      created: z.array(z.string()),
      skipped: z.array(z.string()),
      failed: z.array(z.object({ name: z.string(), error: z.string() })),
    }),
    handle: async ({ guild_id, alert_channel_id, confirm }) => {
      const guild = await getGuild(guild_id);
      const definitions = [
        {
          name: "Block invite links",
          triggerType: AutoModerationRuleTriggerType.Keyword,
          triggerMetadata: {
            regexPatterns: ["(discord\\.gg|discord(?:app)?\\.com/invite)/[A-Za-z0-9-]+"],
          },
          actions: [{ type: AutoModerationActionType.BlockMessage, metadata: {} }],
        },
        {
          name: "Block scam keywords",
          triggerType: AutoModerationRuleTriggerType.KeywordPreset,
          triggerMetadata: { presets: [AutoModerationRuleKeywordPresetType.Profanity] },
          actions: [{ type: AutoModerationActionType.BlockMessage, metadata: {} }],
        },
        {
          name: "Mention spam protection",
          triggerType: AutoModerationRuleTriggerType.MentionSpam,
          triggerMetadata: { mentionTotalLimit: 6, mentionRaidProtectionEnabled: true },
          actions: [{ type: AutoModerationActionType.BlockMessage, metadata: {} }],
        },
        {
          name: "Timeout repeat offenders",
          triggerType: AutoModerationRuleTriggerType.KeywordPreset,
          triggerMetadata: { presets: [AutoModerationRuleKeywordPresetType.Slurs] },
          actions: [
            { type: AutoModerationActionType.BlockMessage, metadata: {} },
            { type: AutoModerationActionType.Timeout, metadata: { durationSeconds: 600 } },
          ],
        },
      ] as const;

      if (!confirm) {
        return structured({
          mode: "preview",
          planned: definitions.map((d) => d.name),
          created: [],
          skipped: [],
          failed: [],
        });
      }
      assertBotPermission(guild, "ManageGuild", "creating AutoMod rules");
      const existing = new Set((await guild.autoModerationRules.fetch()).map((r) => r.name));
      const created: string[] = [];
      const skipped: string[] = [];
      const failed: { name: string; error: string }[] = [];
      for (const definition of definitions) {
        if (existing.has(definition.name)) {
          skipped.push(definition.name);
          continue;
        }
        try {
          const actions = definition.actions.map((action) => ({
            type: action.type,
            metadata: {
              ...("durationSeconds" in action.metadata
                ? { durationSeconds: action.metadata.durationSeconds }
                : {}),
              ...(alert_channel_id ? { channel: alert_channel_id } : {}),
            },
          }));
          await guild.autoModerationRules.create({
            name: definition.name,
            eventType: AutoModerationRuleEventType.MessageSend,
            triggerType: definition.triggerType,
            triggerMetadata: definition.triggerMetadata as never,
            actions: actions as never,
            enabled: true,
          });
          created.push(definition.name);
        } catch (err) {
          failed.push({
            name: definition.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      recordAction({
        tool: "discord_apply_automod_baseline",
        guildId: guild_id,
        summary: `Created ${created.length} AutoMod rule(s), ${failed.length} failure(s)`,
        outcome: "applied",
      });
      return structured({
        mode: "apply",
        planned: definitions.map((d) => d.name),
        created,
        skipped,
        failed,
      });
    },
  }),
];

export default defineModule(tools);
