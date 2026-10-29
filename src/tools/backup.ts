import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";
import { z } from "zod";
import { buildChannelCreateOptions as buildCreateOptions } from "../channelOptions.js";
import {
  assertBotPermission,
  getGuild,
  parsePermissionNames,
  serializePermissions,
} from "../client.js";
import { recordAction, runPaced } from "../safety.js";
import { defineModule, defineTool, guildId, structured } from "./define.js";

/**
 * Structural backup, comparison and restore.
 *
 * A backup is a JSON document describing categories, channels, permission
 * overwrites and roles. It captures *structure and permissions*, deliberately
 * not messages: Discord's API cannot read a channel's full history cheaply, and
 * a tool that promised a message backup would be lying about what it retrieved.
 *
 * Restore is additive and idempotent by name: it creates what is missing and
 * leaves what already exists alone. It never deletes, because a restore that
 * removes entities is indistinguishable from a destructive wipe when the backup
 * is stale.
 */

const overwriteSchema = z.strictObject({
  target_id: z.string(),
  target_type: z.enum(["role", "member"]),
  allow: z.array(z.string()),
  deny: z.array(z.string()),
});

const channelSnapshotSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  position: z.number(),
  parent_id: z.string().nullable(),
  topic: z.string().nullable().optional(),
  nsfw: z.boolean().optional(),
  slowmode: z.number().optional(),
  overwrites: z.array(overwriteSchema),
});

const roleSnapshotSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  position: z.number(),
  hoist: z.boolean(),
  mentionable: z.boolean(),
  managed: z.boolean(),
  permissions: z.array(z.string()),
});

const backupSchema = z.strictObject({
  format: z.literal("discord-mcp-ultimate/structure-backup@1"),
  created_at: z.string(),
  guild_id: z.string(),
  guild_name: z.string(),
  roles: z.array(roleSnapshotSchema),
  categories: z.array(channelSnapshotSchema),
  channels: z.array(channelSnapshotSchema),
});

/** Reads the full structural snapshot of a guild. */
async function snapshot(guild: Guild) {
  await guild.channels.fetch();
  await guild.roles.fetch();
  const describe = (
    c: (typeof guild.channels.cache extends Map<string, infer C> ? C : never) & {
      id: string;
      name: string;
      type: ChannelType;
      position?: number;
      parentId?: string | null;
      topic?: string | null;
      nsfw?: boolean;
      rateLimitPerUser?: number | null;
      permissionOverwrites: {
        cache: Map<string, { id: string; type: number; allow: never; deny: never }>;
      };
    },
  ) => ({
    id: c.id,
    name: c.name,
    type: ChannelType[c.type] ?? String(c.type),
    position: c.position ?? 0,
    parent_id: c.parentId ?? null,
    topic: c.topic ?? null,
    nsfw: c.nsfw ?? false,
    slowmode: c.rateLimitPerUser ?? 0,
    overwrites: [...c.permissionOverwrites.cache.values()].map((ow) => ({
      target_id: ow.id,
      target_type: (ow.type === 0 ? "role" : "member") as "role" | "member",
      allow: serializePermissions(ow.allow as never),
      deny: serializePermissions(ow.deny as never),
    })),
  });

  const categories = [...guild.channels.cache.values()]
    .filter((c) => c.type === ChannelType.GuildCategory)
    .map((c) => describe(c as never));
  const channels = [...guild.channels.cache.values()]
    .filter((c) => c.type !== ChannelType.GuildCategory)
    .map((c) => describe(c as never));
  const roles = [...guild.roles.cache.values()].map((r) => ({
    id: r.id,
    name: r.name,
    color: r.hexColor,
    position: r.position,
    hoist: r.hoist,
    mentionable: r.mentionable,
    managed: r.managed,
    permissions: serializePermissions(r.permissions),
  }));

  return { categories, channels, roles };
}

const tools = [
  defineTool({
    name: "discord_export_structure",
    description:
      "Export the server's structure as a portable JSON backup: every category and channel with its type, position, topic, slowmode and permission overwrites, plus every role with its permissions. LIMITATION, stated plainly: this backs up structure and permissions, NOT messages. Discord's API cannot enumerate a channel's full history in one call, and this server does not pretend otherwise. The output is a plain JSON document the caller can store; nothing is written to disk by the server. Requires no special permission beyond being able to read the guild. Read-only.",
    annotations: { title: "Export server structure", readOnlyHint: true, openWorldHint: true },
    schema: z.object({ guild_id: guildId }),
    outputSchema: z.object({
      backup: backupSchema,
      summary: z.object({
        categories: z.number(),
        channels: z.number(),
        roles: z.number(),
        overwrites: z.number(),
        message_history_included: z.boolean(),
      }),
    }),
    handle: async ({ guild_id }) => {
      const guild = await getGuild(guild_id);
      const { categories, channels, roles } = await snapshot(guild);
      const backup = {
        format: "discord-mcp-ultimate/structure-backup@1" as const,
        created_at: new Date().toISOString(),
        guild_id: guild.id,
        guild_name: guild.name,
        roles,
        categories,
        channels,
      };
      return structured({
        backup,
        summary: {
          categories: categories.length,
          channels: channels.length,
          roles: roles.length,
          overwrites: [...categories, ...channels].reduce(
            (total, c) => total + c.overwrites.length,
            0,
          ),
          message_history_included: false,
        },
      });
    },
  }),
  defineTool({
    name: "discord_compare_structure",
    description:
      "Diff a structure backup against the live server and report what changed: channels and categories present in one but not the other, roles added or removed, and permission overwrites that differ. Read-only. Use this to answer 'what changed since the backup?' or to check drift before restoring.",
    annotations: { title: "Compare backup to server", readOnlyHint: true, openWorldHint: true },
    schema: z.object({
      guild_id: guildId,
      backup: backupSchema,
    }),
    outputSchema: z.object({
      channels_only_in_backup: z.array(z.string()),
      channels_only_on_server: z.array(z.string()),
      categories_only_in_backup: z.array(z.string()),
      categories_only_on_server: z.array(z.string()),
      roles_only_in_backup: z.array(z.string()),
      roles_only_on_server: z.array(z.string()),
      permission_differences: z.array(
        z.object({ channel: z.string(), target_id: z.string(), detail: z.string() }),
      ),
      summary: z.string(),
    }),
    handle: async ({ guild_id, backup }) => {
      const guild = await getGuild(guild_id);
      const live = await snapshot(guild);
      const nameOf = <T extends { name: string }>(items: T[]) => new Set(items.map((i) => i.name));
      const backupChannels = nameOf(backup.channels);
      const liveChannels = nameOf(live.channels);
      const backupCategories = nameOf(backup.categories);
      const liveCategories = nameOf(live.categories);
      const backupRoles = nameOf(backup.roles);
      const liveRoles = nameOf(live.roles);

      const permissionDifferences: { channel: string; target_id: string; detail: string }[] = [];
      for (const backupChannel of backup.channels) {
        const liveChannel = live.channels.find((c) => c.name === backupChannel.name);
        if (!liveChannel) continue;
        const key = (ow: { target_id: string; allow: string[]; deny: string[] }) =>
          `${ow.target_id}:${[...ow.allow].sort().join(",")}|${[...ow.deny].sort().join(",")}`;
        const liveKeys = new Set(liveChannel.overwrites.map(key));
        for (const ow of backupChannel.overwrites) {
          if (!liveKeys.has(key(ow)))
            permissionDifferences.push({
              channel: backupChannel.name,
              target_id: ow.target_id,
              detail: `backup allow=[${ow.allow.join(",")}] deny=[${ow.deny.join(",")}]`,
            });
        }
      }

      const diff = {
        channels_only_in_backup: [...backupChannels].filter((n) => !liveChannels.has(n)),
        channels_only_on_server: [...liveChannels].filter((n) => !backupChannels.has(n)),
        categories_only_in_backup: [...backupCategories].filter((n) => !liveCategories.has(n)),
        categories_only_on_server: [...liveCategories].filter((n) => !backupCategories.has(n)),
        roles_only_in_backup: [...backupRoles].filter(
          (n) => !liveRoles.has(n) && n !== "@everyone",
        ),
        roles_only_on_server: [...liveRoles].filter(
          (n) => !backupRoles.has(n) && n !== "@everyone",
        ),
        permission_differences: permissionDifferences,
      };
      return structured({
        ...diff,
        summary: `${diff.channels_only_in_backup.length} channel(s) missing, ${diff.channels_only_on_server.length} extra channel(s), ${diff.roles_only_in_backup.length} missing role(s), ${permissionDifferences.length} permission difference(s).`,
      });
    },
  }),
  defineTool({
    name: "discord_restore_structure",
    description:
      "Restore a structure backup into a server. PREVIEWS BY DEFAULT: returns exactly what would be created; re-call with confirm:true to apply. ADDITIVE ONLY: it creates roles, categories and channels that are missing and never deletes or renames anything, because a restore that removes entities turns a stale backup into a wipe. Permission overwrites are re-applied by matching role NAMES from the backup to the live server's roles; member-specific overwrites are skipped, since user IDs differ across servers. Requires Manage Channels and Manage Roles.",
    annotations: {
      title: "Restore structure backup",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      guild_id: guildId,
      backup: backupSchema,
      confirm: z
        .boolean()
        .default(false)
        .describe("Set true to actually create. Default false returns a preview."),
      include_roles: z.boolean().default(true).describe("Also create missing roles."),
    }),
    outputSchema: z.object({
      mode: z.string(),
      applied: z.boolean(),
      planned: z.array(z.string()),
      created: z.array(z.object({ kind: z.string(), name: z.string(), id: z.string() })),
      skipped: z.array(z.object({ kind: z.string(), name: z.string(), reason: z.string() })),
      failed: z.array(z.object({ kind: z.string(), name: z.string(), error: z.string() })),
      notes: z.array(z.string()),
    }),
    handle: async ({ guild_id, backup, confirm, include_roles }) => {
      const guild = await getGuild(guild_id);
      const live = await snapshot(guild);
      const liveChannelNames = new Set(live.channels.map((c) => c.name));
      const liveCategoryNames = new Set(live.categories.map((c) => c.name));
      const liveRoleNames = new Set(live.roles.map((r) => r.name));

      const rolesToCreate = include_roles
        ? backup.roles.filter(
            (r) => r.name !== "@everyone" && !r.managed && !liveRoleNames.has(r.name),
          )
        : [];
      const categoriesToCreate = backup.categories.filter((c) => !liveCategoryNames.has(c.name));
      const channelsToCreate = backup.channels.filter((c) => !liveChannelNames.has(c.name));

      const planned = [
        ...rolesToCreate.map((r) => `role:${r.name}`),
        ...categoriesToCreate.map((c) => `category:${c.name}`),
        ...channelsToCreate.map((c) => `channel:${c.name}`),
      ];

      if (!confirm) {
        return structured({
          mode: "preview",
          applied: false,
          planned,
          created: [],
          skipped: [],
          failed: [],
          notes: [
            "Restore is additive: nothing on the server is deleted or renamed.",
            "Member-specific permission overwrites are skipped; only role overwrites are re-applied.",
          ],
        });
      }

      assertBotPermission(guild, "ManageChannels", "restoring channels");
      if (rolesToCreate.length > 0) assertBotPermission(guild, "ManageRoles", "restoring roles");

      const created: { kind: string; name: string; id: string }[] = [];
      const skipped: { kind: string; name: string; reason: string }[] = [];
      const failed: { kind: string; name: string; error: string }[] = [];
      const roleIdByName = new Map(live.roles.map((r) => [r.name, r.id]));

      const { failures: roleFailures } = await runPaced(rolesToCreate, async (role) => {
        const permissions = parsePermissionNames(role.permissions);
        const createdRole = await guild.roles.create({
          name: role.name,
          color: (role.color === "#000000" ? undefined : role.color) as never,
          hoist: role.hoist,
          mentionable: role.mentionable,
          permissions: permissions.reduce(
            (bits, p) => bits | PermissionFlagsBits[p as keyof typeof PermissionFlagsBits],
            0n,
          ),
        });
        roleIdByName.set(role.name, createdRole.id);
        created.push({ kind: "role", name: role.name, id: createdRole.id });
      });
      for (const failure of roleFailures)
        failed.push({ kind: "role", name: failure.item.name, error: failure.error });

      const { failures: categoryFailures } = await runPaced(
        categoriesToCreate,
        async (category) => {
          const createdCategory = await guild.channels.create({
            name: category.name,
            type: ChannelType.GuildCategory,
          });
          created.push({ kind: "category", name: category.name, id: createdCategory.id });
        },
      );
      for (const failure of categoryFailures)
        failed.push({ kind: "category", name: failure.item.name, error: failure.error });

      const categoryIdByName = new Map(
        [...guild.channels.cache.values()]
          .filter((c) => c.type === ChannelType.GuildCategory)
          .map((c) => [c.name, c.id]),
      );
      const { failures: channelFailures } = await runPaced(channelsToCreate, async (channel) => {
        const parentId = channel.parent_id
          ? (categoryIdByName.get(
              backup.categories.find((c) => c.id === channel.parent_id)?.name ?? "",
            ) ?? null)
          : null;
        const overwrites = channel.overwrites
          .filter((ow) => ow.target_type === "role")
          .map((ow) => {
            const roleName = backup.roles.find((r) => r.id === ow.target_id)?.name;
            const liveId = roleName ? roleIdByName.get(roleName) : undefined;
            return liveId
              ? {
                  id: liveId,
                  allow: parsePermissionNames(ow.allow) as never,
                  deny: parsePermissionNames(ow.deny) as never,
                }
              : null;
          })
          .filter((ow): ow is { id: string; allow: never; deny: never } => ow !== null);
        const createdChannel = await guild.channels.create(
          buildCreateOptions({
            name: channel.name,
            type: ChannelType[channel.type as keyof typeof ChannelType] ?? ChannelType.GuildText,
            parent: parentId,
            overwrites,
          }),
        );
        created.push({ kind: "channel", name: channel.name, id: createdChannel.id });
      });
      for (const failure of channelFailures)
        failed.push({ kind: "channel", name: failure.item.name, error: failure.error });

      skipped.push({
        kind: "channel",
        name: `${liveChannelNames.size - channelsToCreate.length} existing channel(s)`,
        reason: "already present; restore never overwrites",
      });

      recordAction({
        tool: "discord_restore_structure",
        guildId: guild_id,
        summary: `Restored ${created.length} entity/ies, ${failed.length} failure(s)`,
        outcome: "applied",
      });
      return structured({
        mode: "apply",
        applied: true,
        planned,
        created,
        skipped,
        failed,
        notes: [
          "Member-specific permission overwrites were skipped; only role overwrites were re-applied.",
        ],
      });
    },
  }),
];

export default defineModule(tools);
