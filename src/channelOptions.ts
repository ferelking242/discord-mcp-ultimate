import { ChannelType, type Guild, type OverwriteResolvable } from "discord.js";

/**
 * Builds the options object for `guild.channels.create`.
 *
 * Discord rejects fields on channel types that do not support them: `topic` and
 * `rateLimitPerUser` are text/announcement-only, and the `create` overload set is
 * keyed by the literal channel type. This helper narrows the payload to the
 * fields the chosen type accepts, so a voice channel is never sent a topic and a
 * forum is never sent a slowmode, instead of casting the whole object through
 * `any` and discovering the problem in a 400 from Discord.
 */
export function buildChannelCreateOptions(input: {
  name: string;
  type: ChannelType;
  parent?: string | null;
  topic?: string;
  slowmode?: number;
  nsfw?: boolean;
  overwrites?: OverwriteResolvable[];
  reason?: string;
}): Parameters<Guild["channels"]["create"]>[0] {
  const options: Record<string, unknown> = { name: input.name, type: input.type };
  if (input.parent) options.parent = input.parent;
  if (input.overwrites && input.overwrites.length > 0)
    options.permissionOverwrites = input.overwrites;
  if (input.reason) options.reason = input.reason;
  if (input.type === ChannelType.GuildText || input.type === ChannelType.GuildNews) {
    if (input.topic !== undefined) options.topic = input.topic;
    if (input.slowmode !== undefined) options.rateLimitPerUser = input.slowmode;
  }
  if (input.nsfw !== undefined) options.nsfw = input.nsfw;
  return options as unknown as Parameters<Guild["channels"]["create"]>[0];
}
