import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
  type OverwriteResolvable,
  type Role,
} from "discord.js";
import { z } from "zod";
import { buildChannelCreateOptions } from "../channelOptions.js";
import { assertBotPermission, getGuild, parsePermissionNames } from "../client.js";
import { confirmationPhrase, isDuplicateFingerprint, recordAction, runPaced } from "../safety.js";
import { entityKindSchema, styleName, type EntityKind } from "../styleGenerator.js";
import { defineModule, defineTool, guildId, intIn, structured } from "./define.js";

/**
 * Server architect: plan, build, diff and repair a whole server structure.
 *
 * The unit of work is a *plan*, not an individual API call, because a model
 * asked to "set up our community server" cannot reliably emit thirty correctly
 * ordered channel creations in one shot. The plan is a plain JSON document that
 * can be previewed, diffed against the live server, applied in resumable steps,
 * and re-applied safely after a partial failure.
 *
 * A plan is declarative: it names the entities it wants and the desired state,
 * not the API calls to reach it. Applying a plan therefore converges: entities
 * that already exist by name are updated rather than duplicated, so a re-run
 * after a network failure repairs the server instead of doubling it.
 */

/** How a role is referenced inside a plan, before it has a Discord ID. */
const rolePlan = z.strictObject({
  key: z
    .string()
    .regex(/^[a-z0-9_]+$/, "Use lowercase letters, digits and underscores.")
    .describe("Stable identifier used to reference this role elsewhere in the plan."),
  name: z.string().describe("Display name. A Unicode style is applied if the plan has a theme."),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Hex color like '#FF5733'.")
    .optional()
    .describe("Role color as a hex string."),
  hoist: z.boolean().optional().describe("Show members with this role separately."),
  mentionable: z.boolean().optional().describe("Allow anyone to @mention this role."),
  permissions: z
    .array(z.string())
    .optional()
    .describe("Server-wide permission flag names, e.g. ['ViewChannel','SendMessages']."),
});

/** A channel the plan wants inside a category. */
const channelPlan = z.strictObject({
  name: z.string().describe("Channel name, styled by the plan theme."),
  kind: z
    .enum(["text", "voice", "forum", "announcement", "stage", "rules", "support", "community"])
    .describe(
      "Logical kind. 'rules' and 'support' are text channels with a conventional purpose; 'community' is a plain text channel.",
    ),
  topic: z.string().optional().describe("Channel topic (text channels only)."),
  slowmode: intIn(0, 21600).optional().describe("Per-user cooldown in seconds."),
  nsfw: z.boolean().optional().describe("Mark the channel age-restricted."),
  /** Role keys (from `roles`) that should be allowed to view this channel. */
  viewable_by: z
    .array(z.string())
    .optional()
    .describe("Role keys that may view this channel. Omit to leave the default (@everyone)."),
  /** Role keys that should be denied the view. */
  hidden_from: z
    .array(z.string())
    .optional()
    .describe("Role keys that may not view this channel, e.g. ['member'] for a staff channel."),
  read_only_for: z
    .array(z.string())
    .optional()
    .describe("Role keys that can view but not send, e.g. ['member'] on a rules channel."),
  emoji: z.string().optional().describe("Explicit emoji for the styled name."),
});

/** A category and the channels it contains. */
const categoryPlan = z.strictObject({
  name: z.string().describe("Category name, styled by the plan theme."),
  kind: entityKindSchema.optional().describe("Naming kind; defaults to 'category'."),
  channels: z.array(channelPlan).default([]).describe("Channels inside this category."),
  hidden_from: z
    .array(z.string())
    .optional()
    .describe("Role keys denied access to the whole category."),
  emoji: z.string().optional().describe("Explicit emoji for the styled name."),
});

/** The full declarative plan. */
const planSchema = z.strictObject({
  theme: z
    .string()
    .optional()
    .describe("Unicode style applied to every generated name. Omit for plain names."),
  roles: z.array(rolePlan).default([]).describe("Roles to create or update."),
  categories: z.array(categoryPlan).default([]).describe("Categories and their channels."),
  /** Channels that live outside any category. */
  uncategorized: z.array(channelPlan).default([]).describe("Channels not inside a category."),
  /** Category names that should exist but stay empty. */
  system_channels: z
    .strictObject({
      rules_channel: z
        .string()
        .optional()
        .describe("Channel name to register as the rules channel."),
      public_updates_channel: z
        .string()
        .optional()
        .describe("Channel name to register as the public-updates channel."),
      system_channel: z.string().optional().describe("Channel name to use as the system channel."),
    })
    .optional()
    .describe("Special channel slots to wire up after creation (requires Community)."),
});

export type ArchitectPlan = z.infer<typeof planSchema>;

/** A single unit of work the applier executes. */
interface BuildStep {
  /** Stable key: `role:<key>`, `category:<name>`, or `channel:<category>/<name>`. */
  key: string;
  kind: "role" | "category" | "channel";
  label: string;
  /** Category this channel belongs to, by styled name, if any. */
  parentName?: string;
  payload: Record<string, unknown>;
}

/**
 * Turns a declarative plan into an ordered, idempotent list of steps.
 *
 * Ordering matters: roles are created first so channel overwrites can reference
 * them, and categories before their children. The steps are derived purely from
 * the plan, so a preview and an apply describe exactly the same work.
 */
export function planToSteps(plan: ArchitectPlan): BuildStep[] {
  const style = (name: string, kind: EntityKind, emoji?: string) =>
    plan.theme ? styleName(name, { style: plan.theme as never, emoji }).name : name;

  const steps: BuildStep[] = [];
  for (const role of plan.roles) {
    steps.push({
      key: `role:${role.key}`,
      kind: "role",
      label: style(role.name, "role"),
      payload: {
        key: role.key,
        name: style(role.name, "role"),
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: role.permissions,
      },
    });
  }
  const kindToChannelType: Record<string, ChannelType> = {
    text: ChannelType.GuildText,
    voice: ChannelType.GuildVoice,
    forum: ChannelType.GuildForum,
    announcement: ChannelType.GuildNews,
    stage: ChannelType.GuildStageVoice,
    rules: ChannelType.GuildText,
    support: ChannelType.GuildText,
    community: ChannelType.GuildText,
  };
  const kindToEntityKind: Record<string, EntityKind> = {
    text: "text_channel",
    voice: "voice_channel",
    forum: "forum_channel",
    announcement: "announcement_channel",
    stage: "voice_channel",
    rules: "rules_channel",
    support: "support_channel",
    community: "community_channel",
  };
  for (const category of plan.categories) {
    const categoryName = style(category.name, "category", category.emoji);
    steps.push({
      key: `category:${category.name}`,
      kind: "category",
      label: categoryName,
      payload: {
        name: categoryName,
        hidden_from: category.hidden_from,
      },
    });
    for (const channel of category.channels) {
      steps.push({
        key: `channel:${category.name}/${channel.name}`,
        kind: "channel",
        label: style(channel.name, kindToEntityKind[channel.kind]!, channel.emoji),
        parentName: category.name,
        payload: {
          name: style(channel.name, kindToEntityKind[channel.kind]!, channel.emoji),
          type: kindToChannelType[channel.kind]!,
          topic: channel.topic,
          slowmode: channel.slowmode,
          nsfw: channel.nsfw,
          viewable_by: channel.viewable_by,
          hidden_from: channel.hidden_from,
          read_only_for: channel.read_only_for,
        },
      });
    }
  }
  for (const channel of plan.uncategorized) {
    steps.push({
      key: `channel:/${channel.name}`,
      kind: "channel",
      label: style(channel.name, kindToEntityKind[channel.kind]!, channel.emoji),
      payload: {
        name: style(channel.name, kindToEntityKind[channel.kind]!, channel.emoji),
        type: kindToChannelType[channel.kind]!,
        topic: channel.topic,
        slowmode: channel.slowmode,
        nsfw: channel.nsfw,
        viewable_by: channel.viewable_by,
        hidden_from: channel.hidden_from,
        read_only_for: channel.read_only_for,
      },
    });
  }
  return steps;
}

/** A snapshot of what the guild already has, keyed by lowercase name. */
interface GuildSnapshot {
  roles: Map<string, Role>;
  categories: Map<string, GuildBasedChannel>;
  channels: Map<string, GuildBasedChannel>;
}

async function snapshotGuild(guild: Guild): Promise<GuildSnapshot> {
  await guild.channels.fetch();
  await guild.roles.fetch();
  const roles = new Map<string, Role>();
  for (const role of guild.roles.cache.values()) roles.set(role.name.toLowerCase(), role);
  const categories = new Map<string, GuildBasedChannel>();
  const channels = new Map<string, GuildBasedChannel>();
  for (const channel of guild.channels.cache.values()) {
    if (channel.type === ChannelType.GuildCategory)
      categories.set(channel.name.toLowerCase(), channel);
    else channels.set(channel.name.toLowerCase(), channel);
  }
  return { roles, categories, channels };
}

/** Compares a plan against the live guild, per step. */
function diffSteps(
  steps: BuildStep[],
  snapshot: GuildSnapshot,
): { step: BuildStep; action: "create" | "exists" }[] {
  return steps.map((step) => {
    const exists =
      step.kind === "role"
        ? snapshot.roles.has(step.label.toLowerCase())
        : step.kind === "category"
          ? snapshot.categories.has(step.label.toLowerCase())
          : snapshot.channels.has(step.label.toLowerCase());
    return { step, action: exists ? "exists" : "create" };
  });
}

/** Builds channel permission overwrites from role keys. */
function buildOverwrites(
  payload: Record<string, unknown>,
  roleIds: Map<string, string>,
): OverwriteResolvable[] {
  const overwrites: OverwriteResolvable[] = [];
  const asArray = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);
  for (const key of asArray(payload.viewable_by)) {
    const id = roleIds.get(key);
    if (id) overwrites.push({ id, allow: [PermissionFlagsBits.ViewChannel] });
  }
  for (const key of asArray(payload.hidden_from)) {
    const id = roleIds.get(key);
    if (id) overwrites.push({ id, deny: [PermissionFlagsBits.ViewChannel] });
  }
  for (const key of asArray(payload.read_only_for)) {
    const id = roleIds.get(key);
    if (id)
      overwrites.push({
        id,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: [PermissionFlagsBits.SendMessages],
      });
  }
  return overwrites;
}

/** Tool definitions for planning, building, diffing and repairing server structure. */
const tools = [
  defineTool({
    name: "discord_architect_plan",
    description:
      "Validate and normalise a server-structure plan without touching Discord. Takes a declarative plan (roles, categories, channels, permission intents) and returns the exact ordered steps that discord_architect_apply would execute, plus any problem in the plan (duplicate names, unknown role keys, unsupported field combinations). Read-only. This is the tool to call first for any 'build me a server' request: it is the cheapest way to show the user what would happen. The plan is declarative, not a script: re-applying it converges on the described state instead of duplicating entities.",
    annotations: { title: "Validate build plan", readOnlyHint: true, openWorldHint: false },
    schema: z.object({ plan: planSchema }),
    outputSchema: z.object({
      step_count: z.number(),
      steps: z.array(
        z.object({
          key: z.string(),
          kind: z.string(),
          label: z.string(),
          parent: z.string().nullable(),
        }),
      ),
      problems: z.array(z.string()),
    }),
    handle: async ({ plan }) => {
      const steps = planToSteps(plan as ArchitectPlan);
      const problems = validatePlan(plan as ArchitectPlan, steps);
      return structured({
        step_count: steps.length,
        steps: steps.map((s) => ({
          key: s.key,
          kind: s.kind,
          label: s.label,
          parent: s.parentName ?? null,
        })),
        problems,
      });
    },
  }),
  defineTool({
    name: "discord_architect_read_structure",
    description:
      "Read the live server structure in the same shape a plan uses: categories with their channels, uncategorised channels, and roles. Use this to see what exists before building, or to hand the result back to a model that will propose a plan. Read-only.",
    annotations: { title: "Read server structure", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({
      guild_id: z.string(),
      guild_name: z.string(),
      categories: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          position: z.number(),
          channels: z.array(
            z.object({ id: z.string(), name: z.string(), type: z.string(), position: z.number() }),
          ),
        }),
      ),
      uncategorized: z.array(
        z.object({ id: z.string(), name: z.string(), type: z.string(), position: z.number() }),
      ),
      roles: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          position: z.number(),
          color: z.string(),
          hoist: z.boolean(),
          mentionable: z.boolean(),
          member_count: z.number(),
        }),
      ),
    }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      await guild.channels.fetch();
      await guild.roles.fetch();
      const describe = (c: GuildBasedChannel) => ({
        id: c.id,
        name: c.name,
        type: ChannelType[c.type] ?? String(c.type),
        position: "position" in c ? (c.position as number) : 0,
      });
      const categories = [...guild.channels.cache.values()]
        .filter((c) => c.type === ChannelType.GuildCategory)
        .sort(
          (a, b) =>
            (a as never as { position: number }).position -
            (b as never as { position: number }).position,
        )
        .map((cat) => ({
          id: cat.id,
          name: cat.name,
          position: (cat as never as { position: number }).position,
          channels: [...guild.channels.cache.values()]
            .filter((c) => c.parentId === cat.id)
            .sort(
              (a, b) =>
                (a as never as { position: number }).position -
                (b as never as { position: number }).position,
            )
            .map(describe),
        }));
      const uncategorized = [...guild.channels.cache.values()]
        .filter((c) => c.type !== ChannelType.GuildCategory && !c.parentId)
        .sort(
          (a, b) =>
            (a as never as { position: number }).position -
            (b as never as { position: number }).position,
        )
        .map(describe);
      const counts = await guild.roles.fetchMemberCounts().catch(() => new Map<string, number>());
      const roles = [...guild.roles.cache.values()]
        .sort((a, b) => b.position - a.position)
        .map((r) => ({
          id: r.id,
          name: r.name,
          position: r.position,
          color: r.hexColor,
          hoist: r.hoist,
          mentionable: r.mentionable,
          member_count: counts.get(r.id) ?? 0,
        }));
      return structured({
        guild_id: guild.id,
        guild_name: guild.name,
        categories,
        uncategorized,
        roles,
      });
    },
  }),
  defineTool({
    name: "discord_architect_compare",
    description:
      "Diff a plan against the live server: which roles, categories and channels are missing (would be created), which already exist, and which exist on the server but are absent from the plan (candidates for removal, never removed automatically). Read-only. Use this to answer 'what would change?' or to detect drift before repairing a half-finished build.",
    annotations: { title: "Compare plan to server", readOnlyHint: true, openWorldHint: true },
    schema: z.object({
      guild_id: guildId,
      plan: planSchema,
    }),
    outputSchema: z.object({
      guild_id: z.string(),
      to_create: z.array(z.object({ kind: z.string(), label: z.string() })),
      already_present: z.array(z.object({ kind: z.string(), label: z.string() })),
      only_on_server: z.object({
        categories: z.array(z.string()),
        channels: z.array(z.string()),
        roles: z.array(z.string()),
      }),
      summary: z.string(),
    }),
    handle: async ({ guild_id, plan }) => {
      const guild = await getGuild(guild_id);
      const snapshot = await snapshotGuild(guild);
      const steps = planToSteps(plan as ArchitectPlan);
      const diff = diffSteps(steps, snapshot);
      const plannedNames = {
        categories: new Set(
          steps.filter((s) => s.kind === "category").map((s) => s.label.toLowerCase()),
        ),
        channels: new Set(
          steps.filter((s) => s.kind === "channel").map((s) => s.label.toLowerCase()),
        ),
        roles: new Set(steps.filter((s) => s.kind === "role").map((s) => s.label.toLowerCase())),
      };
      const onlyOnServer = {
        categories: [...snapshot.categories.keys()].filter((n) => !plannedNames.categories.has(n)),
        channels: [...snapshot.channels.keys()].filter((n) => !plannedNames.channels.has(n)),
        roles: [...snapshot.roles.keys()].filter(
          (n) => !plannedNames.roles.has(n) && n !== "@everyone",
        ),
      };
      const toCreate = diff
        .filter((d) => d.action === "create")
        .map((d) => ({ kind: d.step.kind, label: d.step.label }));
      const already = diff
        .filter((d) => d.action === "exists")
        .map((d) => ({ kind: d.step.kind, label: d.step.label }));
      return structured({
        guild_id: guild.id,
        to_create: toCreate,
        already_present: already,
        only_on_server: onlyOnServer,
        summary: `${toCreate.length} to create, ${already.length} already present, ${onlyOnServer.categories.length + onlyOnServer.channels.length} server entities not in the plan (left untouched).`,
      });
    },
  }),
  defineTool({
    name: "discord_architect_apply",
    description:
      "Build a plan against the live server. PREVIEWS BY DEFAULT: returns the step list without changing anything; re-call with confirm:true to apply. Idempotent by name: a role, category or channel that already exists with the planned name is skipped rather than duplicated, so a re-run after a failure repairs the server instead of doubling it. Steps run in order (roles, then categories, then channels) and one failing step does not stop the rest: per-step results are returned so the build can be resumed. Requires Manage Channels and Manage Roles. A duplicate-suppression window rejects an identical plan re-submitted within 60 seconds. This creates structure inside an existing server; it cannot create a new Discord server (see discord_architect_explain_limits).",
    annotations: {
      title: "Build server structure",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      plan: planSchema,
      confirm: z
        .boolean()
        .default(false)
        .describe("Set true to actually create. Default false returns a preview."),
      reason: z.string().optional().describe("Optional reason recorded in the audit log."),
    }),
    outputSchema: z.object({
      mode: z.string(),
      applied: z.boolean(),
      created: z.array(z.object({ kind: z.string(), label: z.string(), id: z.string() })),
      skipped: z.array(z.object({ kind: z.string(), label: z.string(), reason: z.string() })),
      failed: z.array(z.object({ kind: z.string(), label: z.string(), error: z.string() })),
      next_steps: z.array(z.string()),
    }),
    handle: async ({ guild_id, plan, confirm, reason }) => {
      const typedPlan = plan as ArchitectPlan;
      const steps = planToSteps(typedPlan);
      const problems = validatePlan(typedPlan, steps);
      const blocking = problems.filter((p) => !p.startsWith("warning:"));

      // The preview branch runs before any Discord call: a preview that fetched
      // the guild would fail for a caller without a token, and would report
      // "preview" while having already talked to the API.
      if (!confirm) {
        recordAction({
          tool: "discord_architect_apply",
          guildId: guild_id,
          summary: `Previewed a ${steps.length}-step build`,
          outcome: "previewed",
        });
        return structured({
          mode: "preview",
          applied: false,
          created: [],
          skipped: steps.map((s) => ({ kind: s.kind, label: s.label, reason: "preview only" })),
          failed: [],
          next_steps: [
            ...(blocking.length > 0 ? [`Fix these problems first: ${blocking.join(" | ")}`] : []),
            `Re-call discord_architect_apply with confirm:true to create ${steps.length} entities.`,
          ],
        });
      }

      const guild = await getGuild(guild_id);
      if (blocking.length > 0)
        throw new Error(`The plan has ${blocking.length} problem(s): ${blocking.join(" | ")}`);

      const fingerprint = JSON.stringify({ guild_id, steps: steps.map((s) => s.key) });
      if (isDuplicateFingerprint(fingerprint)) {
        throw new Error(
          "An identical build plan was applied less than 60 seconds ago. This guard exists to stop a retry loop from creating duplicate entities. If the first build genuinely failed partway, call discord_architect_compare first to see what is actually missing.",
        );
      }

      assertBotPermission(guild, "ManageChannels", "creating channels");
      assertBotPermission(guild, "ManageRoles", "creating roles");

      const snapshot = await snapshotGuild(guild);
      const created: { kind: string; label: string; id: string }[] = [];
      const skipped: { kind: string; label: string; reason: string }[] = [];
      const failed: { kind: string; label: string; error: string }[] = [];
      const roleIds = new Map<string, string>();
      for (const [name, role] of snapshot.roles) roleIds.set(name, role.id);

      const toRun = steps.filter((step) => {
        const exists =
          step.kind === "role"
            ? snapshot.roles.has(step.label.toLowerCase())
            : step.kind === "category"
              ? snapshot.categories.has(step.label.toLowerCase())
              : snapshot.channels.has(step.label.toLowerCase());
        if (exists) {
          skipped.push({ kind: step.kind, label: step.label, reason: "already exists" });
          if (step.kind === "role") {
            const existing = snapshot.roles.get(step.label.toLowerCase());
            if (existing) roleIds.set(String(step.payload.key), existing.id);
          }
          return false;
        }
        return true;
      });

      const { results, failures } = await runPaced(toRun, async (step) => {
        if (step.kind === "role") {
          const permissions = step.payload.permissions
            ? parsePermissionNames(step.payload.permissions as string[])
            : undefined;
          const role = await guild.roles.create({
            name: step.label,
            color: (step.payload.color as never) ?? undefined,
            hoist: step.payload.hoist as boolean | undefined,
            mentionable: step.payload.mentionable as boolean | undefined,
            permissions: permissions
              ? permissions.reduce(
                  (bits, p) => bits | PermissionFlagsBits[p as keyof typeof PermissionFlagsBits],
                  0n,
                )
              : undefined,
            reason,
          });
          roleIds.set(String(step.payload.key), role.id);
          created.push({ kind: "role", label: step.label, id: role.id });
          return step.key;
        }
        const parent =
          step.parentName === undefined
            ? null
            : ([...guild.channels.cache.values()].find(
                (c) =>
                  c.type === ChannelType.GuildCategory &&
                  c.name.toLowerCase() === step.parentName!.toLowerCase(),
              )?.id ?? null);
        const overwrites = buildOverwrites(step.payload, roleIds);
        const channel = await guild.channels.create(
          buildChannelCreateOptions({
            name: step.label,
            type: step.payload.type as ChannelType,
            parent,
            topic: step.payload.topic as string | undefined,
            slowmode: step.payload.slowmode as number | undefined,
            nsfw: step.payload.nsfw as boolean | undefined,
            overwrites,
            reason,
          }),
        );
        created.push({ kind: step.kind, label: step.label, id: channel.id });
        return step.key;
      });

      for (const failure of failures) {
        failed.push({ kind: failure.item.kind, label: failure.item.label, error: failure.error });
      }
      void results;

      const nextSteps: string[] = [];
      if (failed.length > 0)
        nextSteps.push(
          `Retry: ${failed.length} step(s) failed. Re-call discord_architect_apply with the same plan; entities that succeeded will be skipped.`,
        );
      if (typedPlan.system_channels)
        nextSteps.push(
          "Wire the special channel slots with discord_set_guild_channels once the Community feature is enabled.",
        );
      if (typedPlan.roles.length > 0)
        nextSteps.push("Assign the new roles to members with discord_add_role.");

      recordAction({
        tool: "discord_architect_apply",
        guildId: guild_id,
        summary: `Created ${created.length} entity/ies, skipped ${skipped.length}, ${failed.length} failure(s)`,
        outcome: "applied",
      });
      return structured({
        mode: "apply",
        applied: true,
        created,
        skipped,
        failed,
        next_steps: nextSteps,
      });
    },
  }),
  defineTool({
    name: "discord_architect_repair",
    description:
      "Resume an interrupted build: compares a plan against the live server and reports exactly which steps are still missing, then optionally applies just those. Use this after discord_architect_apply reports failures, or when a build was interrupted. PREVIEWS BY DEFAULT; confirm:true applies the missing steps only. Read-only when confirm is false.",
    annotations: {
      title: "Repair incomplete build",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      plan: planSchema,
      confirm: z.boolean().default(false).describe("Set true to create the missing steps."),
    }),
    outputSchema: z.object({
      mode: z.string(),
      missing: z.array(z.object({ kind: z.string(), label: z.string() })),
      created: z.array(z.object({ kind: z.string(), label: z.string(), id: z.string() })),
      failed: z.array(z.object({ kind: z.string(), label: z.string(), error: z.string() })),
    }),
    handle: async ({ guild_id, plan, confirm }) => {
      const guild = await getGuild(guild_id);
      const snapshot = await snapshotGuild(guild);
      const steps = planToSteps(plan as ArchitectPlan);
      const missing = diffSteps(steps, snapshot).filter((d) => d.action === "create");
      if (!confirm) {
        return structured({
          mode: "preview",
          missing: missing.map((d) => ({ kind: d.step.kind, label: d.step.label })),
          created: [],
          failed: [],
        });
      }
      const missingKeys = new Set(missing.map((d) => d.step.key));
      const { failures } = await runPaced(
        steps.filter((s) => missingKeys.has(s.key)),
        async (step) => {
          if (step.kind === "role") {
            const role = await guild.roles.create({ name: step.label });
            return role.id;
          }
          const parent =
            step.parentName === undefined
              ? null
              : ([...guild.channels.cache.values()].find(
                  (c) =>
                    c.type === ChannelType.GuildCategory &&
                    c.name.toLowerCase() === step.parentName!.toLowerCase(),
                )?.id ?? null);
          const channel = await guild.channels.create(
            buildChannelCreateOptions({
              name: step.label,
              type: step.payload.type as ChannelType,
              parent,
            }),
          );
          return channel.id;
        },
      );
      const created = steps
        .filter((s) => missingKeys.has(s.key))
        .filter((s) => !failures.some((f) => f.item.key === s.key))
        .map((s) => ({ kind: s.kind, label: s.label, id: "" }));
      recordAction({
        tool: "discord_architect_repair",
        guildId: guild_id,
        summary: `Repaired ${created.length} step(s), ${failures.length} failure(s)`,
        outcome: "applied",
      });
      return structured({
        mode: "apply",
        missing: missing.map((d) => ({ kind: d.step.kind, label: d.step.label })),
        created,
        failed: failures.map((f) => ({ kind: f.item.kind, label: f.item.label, error: f.error })),
      });
    },
  }),
  defineTool({
    name: "discord_architect_explain_limits",
    description:
      "Explain what this server can and cannot do about creating Discord servers, with the API reason. Read-only. Use this when asked to 'create a new server': a bot token cannot create a guild. GET /users/@me/guilds and POST /guilds are restricted, so the documented path is: create the server manually (or from a template), invite the bot, then build the structure inside it with discord_architect_apply.",
    annotations: { title: "Explain architect limits", readOnlyHint: true, openWorldHint: false },
    schema: z.object({}),
    outputSchema: z.object({
      can_do: z.array(z.string()),
      cannot_do: z.array(z.object({ operation: z.string(), reason: z.string() })),
      recommended_workflow: z.array(z.string()),
    }),
    handle: async () =>
      structured({
        can_do: [
          "Create, rename, move, reorder and delete categories and channels inside a server the bot is already in.",
          "Create and edit roles, and set per-channel permission overwrites from role keys.",
          "Wire up the rules, public-updates, system and AFK channel slots.",
          "Diff a plan against the live server and repair an interrupted build.",
          "Create a guild template from an existing server (discord_architect_create_template) so the layout can be reused by a human.",
        ],
        cannot_do: [
          {
            operation: "Create a brand-new Discord server (guild)",
            reason:
              "Discord's POST /guilds requires a user OAuth2 bearer token, not a bot token. A bot cannot create a guild, and this server will not pretend to. The bot can only act inside servers it has been invited to.",
          },
          {
            operation: "Create a server from a template",
            reason:
              "POST /guilds/templates/{code} has the same user-token requirement as guild creation. A bot cannot use a template to create a guild; a human must do it.",
          },
          {
            operation: "Create a guild from the API on behalf of a user",
            reason:
              "This would require a user account token, which is a self-bot. Prohibited by Discord's terms and not implemented here.",
          },
        ],
        recommended_workflow: [
          "1. A human creates the Discord server (or applies a template) and invites the bot with the permissions in docs/INSTALLATION.md.",
          "2. The model calls discord_architect_read_structure to see the empty server.",
          "3. The model calls discord_architect_plan to validate the proposed structure.",
          "4. The model calls discord_architect_compare to show the user exactly what would be created.",
          "5. On approval, the model calls discord_architect_apply with confirm:true.",
          "6. If any step failed, discord_architect_repair resumes the build.",
        ],
      }),
  }),
  defineTool({
    name: "discord_architect_create_template",
    description:
      "Create a Discord guild template from the current server, capturing its channels, roles and permissions as a shareable code. Requires Manage Server. IMPORTANT: the code can only be used to create a *new* guild by a human in the Discord client; a bot cannot apply a template to create a guild. Returns the template code and shareable URL.",
    annotations: {
      title: "Create guild template",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      name: z.string().min(1).max(100).describe("Template name."),
      description: z.string().max(120).optional().describe("Template description (max 120 chars)."),
    }),
    outputSchema: z.object({ code: z.string(), url: z.string(), name: z.string() }),
    handle: async ({ guild_id, name, description }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "creating a guild template");
      const template = await guild.createTemplate(name, description);
      recordAction({
        tool: "discord_architect_create_template",
        guildId: guild_id,
        summary: `Created template "${name}"`,
        outcome: "applied",
      });
      return structured({
        code: template.code,
        url: `https://discord.new/${template.code}`,
        name: template.name,
      });
    },
  }),
  defineTool({
    name: "discord_architect_list_templates",
    description:
      "List the guild templates this server has created, with their codes, sync status and update times. Read-only.",
    annotations: { title: "List guild templates", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({
      templates: z.array(
        z.object({
          code: z.string(),
          name: z.string(),
          synced: z.boolean(),
          updated_at: z.string(),
          url: z.string(),
        }),
      ),
    }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      const templates = await guild.fetchTemplates();
      return structured({
        templates: [...templates.values()].map((t) => ({
          code: t.code,
          name: t.name,
          synced: t.serializedGuild !== undefined,
          updated_at: t.updatedAt.toISOString(),
          url: `https://discord.new/${t.code}`,
        })),
      });
    },
  }),
  defineTool({
    name: "discord_architect_delete_template",
    description:
      "Delete a guild template by its code. Requires Manage Server. Not reversible: the template code stops working immediately for anyone who has it. Returns a confirmation.",
    annotations: {
      title: "Delete guild template",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      code: z.string().describe("Template code to delete."),
    }),
    outputSchema: z.object({ deleted: z.string() }),
    handle: async ({ guild_id, code }) => {
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageGuild", "deleting a guild template");
      const templates = await guild.fetchTemplates();
      const template = templates.get(code);
      if (!template) throw new Error(`No template with code "${code}" exists on this server.`);
      await template.delete();
      recordAction({
        tool: "discord_architect_delete_template",
        guildId: guild_id,
        summary: `Deleted template "${code}"`,
        outcome: "applied",
      });
      return structured({ deleted: code });
    },
  }),
  defineTool({
    name: "discord_architect_delete_structure",
    description:
      'Delete channels, categories and roles from a server, driven by a plan (everything in the plan is removed) or by explicit IDs. IRREVERSIBLE: deleted channels lose their message history permanently, and deleted roles are removed from every member. REQUIRES the literal confirmation string "CONFIRM DELETE"; without it the tool returns a preview and deletes nothing. Deletes are performed one at a time and per-entity failures are reported. Requires Manage Channels and Manage Roles.',
    annotations: {
      title: "Delete server structure",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      channel_ids: z.array(z.string()).optional().describe("Channel IDs to delete."),
      role_ids: z.array(z.string()).optional().describe("Role IDs to delete."),
      confirmation: z
        .literal(confirmationPhrase("delete"))
        .optional()
        .describe(`Type exactly "${confirmationPhrase("delete")}" to apply. Omit to preview only.`),
    }),
    outputSchema: z.object({
      mode: z.string(),
      applied: z.boolean(),
      deleted_channels: z.array(z.string()),
      deleted_roles: z.array(z.string()),
      failed: z.array(z.object({ id: z.string(), error: z.string() })),
      would_delete_channels: z.array(z.string()),
      would_delete_roles: z.array(z.string()),
    }),
    handle: async ({ guild_id, channel_ids, role_ids, confirmation }) => {
      const channelTargets = channel_ids ?? [];
      const roleTargets = role_ids ?? [];
      // The preview branch comes first so that omitting the phrase cannot reach
      // Discord at all, even to look up the guild.
      if (confirmation !== "CONFIRM DELETE") {
        return structured({
          mode: "preview",
          applied: false,
          deleted_channels: [],
          deleted_roles: [],
          failed: [],
          would_delete_channels: channelTargets,
          would_delete_roles: roleTargets,
        });
      }
      const guild = await getGuild(guild_id);
      assertBotPermission(guild, "ManageChannels", "deleting channels");
      assertBotPermission(guild, "ManageRoles", "deleting roles");
      const deletedChannels: string[] = [];
      const deletedRoles: string[] = [];
      const failed: { id: string; error: string }[] = [];
      const { failures: channelFailures } = await runPaced(channelTargets, async (id) => {
        const channel = await guild.channels.fetch(id);
        if (!channel) throw new Error(`Channel ${id} not found.`);
        await channel.delete();
        deletedChannels.push(id);
      });
      const { failures: roleFailures } = await runPaced(roleTargets, async (id) => {
        const role = await guild.roles.fetch(id);
        if (!role) throw new Error(`Role ${id} not found.`);
        await role.delete();
        deletedRoles.push(id);
      });
      for (const f of [...channelFailures, ...roleFailures])
        failed.push({ id: f.item, error: f.error });
      recordAction({
        tool: "discord_architect_delete_structure",
        guildId: guild_id,
        summary: `Deleted ${deletedChannels.length} channel(s) and ${deletedRoles.length} role(s)`,
        outcome: "applied",
      });
      return structured({
        mode: "apply",
        applied: true,
        deleted_channels: deletedChannels,
        deleted_roles: deletedRoles,
        failed,
      });
    },
  }),
];

/** Reports structural problems in a plan: duplicates, unknown role keys, bad combos. */
function validatePlan(plan: ArchitectPlan, steps: BuildStep[]): string[] {
  const problems: string[] = [];
  const keys = steps.map((s) => s.key);
  const duplicateKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
  for (const key of new Set(duplicateKeys)) problems.push(`Duplicate step key "${key}".`);

  const labels = steps.map((s) => `${s.kind}:${s.label.toLowerCase()}`);
  const duplicateLabels = labels.filter((l, i) => labels.indexOf(l) !== i);
  for (const label of new Set(duplicateLabels))
    problems.push(
      `warning: two entities would share the name "${label.split(":")[1]}". Discord allows duplicate channel names, but they become indistinguishable in the channel list.`,
    );

  const roleKeys = new Set(plan.roles.map((r) => r.key));
  const referenced = new Set<string>();
  for (const category of plan.categories) {
    for (const key of category.hidden_from ?? []) referenced.add(key);
    for (const channel of category.channels)
      for (const key of [
        ...(channel.viewable_by ?? []),
        ...(channel.hidden_from ?? []),
        ...(channel.read_only_for ?? []),
      ])
        referenced.add(key);
  }
  for (const channel of plan.uncategorized)
    for (const key of [
      ...(channel.viewable_by ?? []),
      ...(channel.hidden_from ?? []),
      ...(channel.read_only_for ?? []),
    ])
      referenced.add(key);
  for (const key of referenced)
    if (!roleKeys.has(key))
      problems.push(
        `Unknown role key "${key}" referenced in a permission list. Add it to plan.roles, or remove the reference.`,
      );

  const invalidRoles = plan.roles.filter((r) => r.permissions && r.permissions.length === 0);
  if (invalidRoles.length > 0)
    problems.push(
      "warning: a role with an empty permissions array is indistinguishable from omitting permissions; the field was ignored.",
    );

  if (steps.length === 0) problems.push("The plan is empty: there is nothing to create.");
  return problems;
}

export default defineModule(tools);
