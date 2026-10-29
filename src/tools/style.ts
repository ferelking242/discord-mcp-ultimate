import { ChannelType, GuildChannel, Role } from "discord.js";
import { z } from "zod";
import { discord } from "../client.js";
import { recordAction, resolveGate } from "../safety.js";
import {
  buildNamingPlan,
  entityKindSchema,
  listStyles,
  STYLE_IDS,
  styleIdSchema,
  styleName,
  type StyleId,
} from "../styleGenerator.js";
import { defineModule, defineTool, guildId, structured } from "./define.js";

const styleSummary = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
});

const planItem = z.object({
  kind: z.string(),
  intent: z.string(),
  name: z.string(),
  slug: z.string(),
  style: z.string(),
  emoji: z.string(),
  fallback: z.boolean(),
  truncated: z.boolean(),
});

const planSchema = z.object({
  theme: z.string(),
  items: z.array(planItem),
  collisions: z.array(z.object({ name: z.string(), intents: z.array(z.string()) })),
  warnings: z.array(z.string()),
});

/**
 * Tools that decorate Discord entity names with Unicode styles.
 *
 * Every description here repeats the same limitation on purpose: Discord has no
 * per-server font setting, so these tools produce decorated *text*, not a font.
 * `discord_apply_name_theme` is the only mutating tool and previews by default.
 */
const tools = [
  defineTool({
    name: "discord_list_name_styles",
    description:
      "List the available Unicode name styles (minimal, gaming, cyberpunk, futuristic, luxury, fantasy, anime, elegant, geometric, bordered, emoji_lead, fullwidth) with a description of each. Read-only, no arguments. Note: these styles decorate text with Unicode characters; Discord does not support applying a custom font to channel, category or role names. Use discord_style_name to preview the result for a specific name.",
    annotations: { title: "List name styles", readOnlyHint: true, openWorldHint: false },
    schema: z.object({}),
    outputSchema: z.object({ styles: z.array(styleSummary) }),
    handle: async () => structured({ styles: listStyles() }),
  }),
  defineTool({
    name: "discord_style_name",
    description:
      "Generate styled variants of one name for a Discord channel, category, forum, or role. Returns one variant per requested style (or every style when none is given). Uses Unicode decorative characters only: this decorates the text, it does not change the font Discord renders, because Discord has no per-server font setting. Empty or punctuation-only input falls back to a readable default name. Use discord_style_preview to plan a whole server at once.",
    annotations: { title: "Style a name", readOnlyHint: true, openWorldHint: false },
    schema: z.object({
      name: z.string().describe("The plain name to decorate, e.g. 'announcements'."),
      styles: z
        .array(styleIdSchema)
        .optional()
        .describe("Styles to generate. Omit to generate one variant for every available style."),
      emoji: z
        .string()
        .optional()
        .describe("Optional leading emoji to use for styles that support one."),
      max_length: z
        .int()
        .min(1)
        .max(100)
        .default(100)
        .describe("Maximum length of each generated name (1–100). Defaults to Discord's 100."),
    }),
    outputSchema: z.object({
      input: z.string(),
      variants: z.array(
        z.object({
          style: z.string(),
          name: z.string(),
          fallback: z.boolean(),
          truncated: z.boolean(),
        }),
      ),
    }),
    handle: async ({ name, styles, emoji, max_length }) => {
      const selected: StyleId[] = styles && styles.length > 0 ? styles : [...STYLE_IDS];
      const variants = selected.map((style) => {
        const styled = styleName(name, { style, emoji, maxLength: max_length });
        return {
          style: styled.style,
          name: styled.name,
          fallback: styled.fallback,
          truncated: styled.truncated,
        };
      });
      return structured({ input: name, variants });
    },
  }),
  defineTool({
    name: "discord_style_preview",
    description:
      "Build a coherent naming plan for a whole server: a shared theme plus per-entity names for categories, text/voice/forum/announcement/rules/support/community channels, and roles. Returns the exact names that would be used, any duplicate names (Discord allows them, but they become indistinguishable in the channel list), and any truncation or fallback that occurred. Read-only: nothing is created or renamed. Use discord_apply_name_theme to actually rename existing entities. These names are decorated text, not a font.",
    annotations: { title: "Preview naming plan", readOnlyHint: true, openWorldHint: false },
    schema: z.object({
      theme: styleIdSchema.describe("Global style applied to every entity unless overridden."),
      items: z
        .array(
          z.strictObject({
            kind: entityKindSchema.describe("What the entity is."),
            name: z.string().describe("Plain, human-readable intent, e.g. 'annonces'."),
            emoji: z.string().optional().describe("Optional explicit emoji for this entity."),
          }),
        )
        .min(1)
        .describe("Entities to name."),
      overrides: z
        .record(z.string(), styleIdSchema)
        .optional()
        .describe("Per-entity style override, keyed by the exact `name` string given above."),
      prefix: z
        .string()
        .optional()
        .describe("Optional prefix applied to every slug, e.g. a server-wide namespace."),
    }),
    outputSchema: planSchema,
    handle: async ({ theme, items, overrides, prefix }) => {
      const plan = buildNamingPlan({ theme, items, overrides, prefix });
      return structured(plan);
    },
  }),
  defineTool({
    name: "discord_apply_name_theme",
    description:
      "Rename existing channels, categories and roles in a server to a Unicode-styled theme. PREVIEWS BY DEFAULT: returns the exact rename list without changing anything. Re-call with confirm:true to apply. Renames are applied one at a time and a failure on one entity does not stop the rest; per-entity results are returned. Requires Manage Channels (and Manage Roles for roles). This changes name text only: Discord cannot apply a custom font. Renaming a channel does not change its ID, so existing links keep working.",
    annotations: {
      title: "Apply name theme",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      theme: styleIdSchema.describe("Global style to apply."),
      include: z
        .array(z.enum(["categories", "text_channels", "voice_channels", "forum_channels", "roles"]))
        .default(["categories", "text_channels", "voice_channels"])
        .describe("Which entity groups to rename. Defaults to categories and channels."),
      keep_plain: z
        .array(z.string())
        .default([])
        .describe("Names (exact, current) to leave untouched, e.g. ['general', 'rules']."),
      confirm: z
        .boolean()
        .default(false)
        .describe("Set true to actually apply the renames. Default false returns a preview."),
    }),
    outputSchema: z.object({
      mode: z.string(),
      applied: z.boolean(),
      planned: z.array(
        z.object({ id: z.string(), kind: z.string(), from: z.string(), to: z.string() }),
      ),
      renamed: z.array(z.object({ id: z.string(), from: z.string(), to: z.string() })),
      failures: z.array(z.object({ id: z.string(), error: z.string() })),
      skipped: z.array(z.string()),
    }),
    handle: async ({ guild_id, theme, include, keep_plain, confirm }) => {
      const guild = await discord.guilds.fetch(guild_id);
      await guild.channels.fetch();
      await guild.roles.fetch();

      const keep = new Set(keep_plain.map((n) => n.toLowerCase()));
      const targets: { entity: GuildChannel | Role; kind: string }[] = [];

      if (include.includes("categories"))
        for (const ch of guild.channels.cache.values())
          if (ch.type === ChannelType.GuildCategory) targets.push({ entity: ch, kind: "category" });
      if (include.includes("text_channels"))
        for (const ch of guild.channels.cache.values())
          if (ch.type === ChannelType.GuildText) targets.push({ entity: ch, kind: "text_channel" });
      if (include.includes("voice_channels"))
        for (const ch of guild.channels.cache.values())
          if (ch.type === ChannelType.GuildVoice)
            targets.push({ entity: ch, kind: "voice_channel" });
      if (include.includes("forum_channels"))
        for (const ch of guild.channels.cache.values())
          if (ch.type === ChannelType.GuildForum)
            targets.push({ entity: ch, kind: "forum_channel" });
      if (include.includes("roles"))
        for (const role of guild.roles.cache.values())
          if (role.name !== "@everyone" && !role.managed)
            targets.push({ entity: role, kind: "role" });

      // styleName slugifies first, so re-running the theme on an already-styled
      // name converges on the same result instead of stacking decorations.
      const planned = targets
        .filter(({ entity }) => !keep.has(entity.name.toLowerCase()))
        .map(({ entity, kind }) => {
          const styled = styleName(entity.name, { style: theme });
          return { id: entity.id, kind, from: entity.name, to: styled.name, entity };
        })
        .filter((entry) => entry.to !== entry.from);

      const gate = resolveGate({ confirm });
      if (gate.preview) {
        recordAction({
          tool: "discord_apply_name_theme",
          guildId: guild_id,
          summary: `Previewed ${planned.length} rename(s)`,
          outcome: "previewed",
        });
        return structured({
          mode: "preview",
          applied: false,
          planned: planned.map(({ id, kind, from, to }) => ({ id, kind, from, to })),
          renamed: [],
          failures: [],
          skipped: [...keep],
        });
      }

      const renamed: { id: string; from: string; to: string }[] = [];
      const failures: { id: string; error: string }[] = [];
      for (const entry of planned) {
        try {
          await entry.entity.setName(entry.to);
          renamed.push({ id: entry.id, from: entry.from, to: entry.to });
        } catch (err) {
          failures.push({ id: entry.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      recordAction({
        tool: "discord_apply_name_theme",
        guildId: guild_id,
        summary: `Renamed ${renamed.length} entity/ies, ${failures.length} failure(s)`,
        outcome: "applied",
      });
      return structured({
        mode: "apply",
        applied: true,
        planned: planned.map(({ id, kind, from, to }) => ({ id, kind, from, to })),
        renamed,
        failures,
        skipped: [...keep],
      });
    },
  }),
];

export default defineModule(tools);
