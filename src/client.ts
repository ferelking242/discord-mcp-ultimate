import "dotenv/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  Guild,
  GuildChannel,
  Options,
  Partials,
  PermissionsBitField,
  Role,
  type GuildTextBasedChannel,
} from "discord.js";
import { SWEEP } from "./constants.js";

/**
 * Initializes the Discord.js client with the gateway intents (privileged ones
 * are opt-out via env) and exposes shared helpers used across all tool modules.
 */

// ─── Discord Client ────────────────────────────────────────────────────────────

/**
 * The token is read at connect time, not at import time: the MCP server is
 * long-lived, and a value captured at module load cannot reflect a token that
 * the host injects later, nor one changed in a test. Reading it here also keeps
 * the value out of any module-level state that could be logged.
 */
function getToken(): string | undefined {
  return process.env.DISCORD_TOKEN;
}

/** Maximum time to wait for the gateway to reach READY before giving up. */
const LOGIN_TIMEOUT_MS = 30_000;

/**
 * Reads a boolean env flag, defaulting to `true`. Set to false/0/no/off to disable.
 * Used to opt out of the two privileged intents when they are not enabled in the
 * Discord Developer Portal (otherwise the gateway closes with code 4014 on connect).
 */
function envEnabled(name: string): boolean {
  const value = process.env[name];
  return value === undefined || !/^(false|0|no|off)$/i.test(value.trim());
}

const messageContentEnabled = envEnabled("DISCORD_MESSAGE_CONTENT");
const guildMembersEnabled = envEnabled("DISCORD_GUILD_MEMBERS");
/**
 * The long-running bot process needs reaction events, which the MCP tool surface
 * does not. Off by default so a stdio user does not request an intent they never
 * use; the bot turns it on and shares this one client rather than opening a second
 * gateway connection with the same token.
 */
const reactionIntentsEnabled = envEnabled("DISCORD_REACTION_INTENTS");

export const discord = new Client({
  // No GuildMessages: nothing consumes MessageCreate, yet it caches every message plus
  // its author. GuildMembers must stay: GUILD_MEMBER_REMOVE is the only eviction event.
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildScheduledEvents,
    ...(messageContentEnabled ? [GatewayIntentBits.MessageContent] : []),
    ...(guildMembersEnabled ? [GatewayIntentBits.GuildMembers] : []),
    ...(reactionIntentsEnabled ? [GatewayIntentBits.GuildMessageReactions] : []),
  ],
  // Partials are fixed at construction: a reaction on a message sent before this
  // process started arrives partial, and cannot be resolved without them.
  ...(reactionIntentsEnabled
    ? { partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User] }
    : {}),
  rest: { retries: 3, timeout: 15_000 },
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: SWEEP.messages,
    threads: SWEEP.threads,
    users: {
      interval: SWEEP.users.interval,
      filter: () => (user) => user.id !== user.client.user?.id,
    },
    guildMembers: {
      interval: SWEEP.guildMembers.interval,
      filter: () => (member) => member.id !== member.client.user?.id,
    },
    // Nothing reads guild.invites.cache back, and fetch() never clears stale entries.
    invites: { interval: SWEEP.invites.interval, filter: () => () => true },
  },
});

let discordReady = false;
let loginPromise: Promise<void> | null = null;

// Without an 'error' listener, an emitted client error crashes the Node process.
discord.on(Events.Error, (err) => console.error("Discord client error:", err.message));
discord.on(Events.ShardError, (err) => console.error("Discord shard error:", err.message));
discord.on(Events.Invalidated, () => {
  console.error(
    "Discord session invalidated: the connection is dead and the next tool call will re-login.",
  );
  discordReady = false;
  loginPromise = null;
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Lazily connects to Discord on first tool call.
 * Allows the MCP server to start and respond to ListTools without a connection.
 */
export async function ensureConnected(): Promise<void> {
  if (discordReady) return;
  // A late READY (after the 30s timeout cleared the listener) must not wedge the
  // server forever: trust the client state, not only our flag.
  if (discord.isReady()) {
    discordReady = true;
    return;
  }

  const token = getToken();
  if (!token) {
    throw new Error("DISCORD_TOKEN is required. Set it in your MCP client config or a .env file.");
  }

  // Cleared only once the attempt settles: a second login replays every guild into the caches.
  if (!loginPromise) {
    loginPromise = (async () => {
      let timer: NodeJS.Timeout | undefined;
      let onReady!: () => void;
      const ready = new Promise<void>((resolve, reject) => {
        onReady = () => {
          clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(() => {
          discord.off(Events.ClientReady, onReady);
          reject(
            new Error(
              `Discord did not reach READY within ${LOGIN_TIMEOUT_MS / 1000}s. Check the token and that the Server Members / Message Content privileged intents are enabled in the Developer Portal, or disable them via DISCORD_GUILD_MEMBERS=false / DISCORD_MESSAGE_CONTENT=false.`,
            ),
          );
        }, LOGIN_TIMEOUT_MS);
        discord.once(Events.ClientReady, onReady);
      });
      ready.catch(() => {});

      try {
        await discord.login(token);
      } catch (err) {
        clearTimeout(timer);
        discord.off(Events.ClientReady, onReady);
        throw new Error(`Discord login failed: ${(err as Error).message}`, { cause: err });
      }
      await ready;
      discordReady = true;
      console.error(`✅  Discord bot connected as ${discord.user?.tag}`);
    })();
    loginPromise.catch(() => {
      loginPromise = null;
    });
  }

  await loginPromise;
}

/** Reads DISCORD_ALLOWED_GUILDS lazily so module import order cannot freeze an empty list. */
function allowedGuilds(): string[] {
  return (process.env.DISCORD_ALLOWED_GUILDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** True when DISCORD_ALLOWED_GUILDS contains at least one guild ID. */
export function allowListActive(): boolean {
  return allowedGuilds().length > 0;
}

/** True if the guild is in DISCORD_ALLOWED_GUILDS, or when no allow-list is configured (empty list allows all guilds). */
export function isGuildAllowed(guildId: string): boolean {
  const list = allowedGuilds();
  return list.length === 0 || list.includes(guildId);
}

/**
 * Central allow-list gate for resources reached without a guild_id input
 * (channel/thread/webhook IDs resolve to a guild only after fetching).
 */
export function assertAllowedGuild(guildId: string | null | undefined): void {
  if (guildId && !isGuildAllowed(guildId))
    throw new Error(`Guild ${guildId} is not in the DISCORD_ALLOWED_GUILDS allow-list.`);
}

/** Fetches a channel and enforces the guild allow-list before returning it. */
export async function fetchChannelChecked(channelId: string, { force = false } = {}) {
  const channel = await discord.channels.fetch(channelId, { force });
  if (channel && "guildId" in channel) assertAllowedGuild(channel.guildId);
  return channel;
}

/**
 * Fetches a channel by ID and guarantees it is a guild channel that holds
 * messages: text, announcement, voice/stage text, or a thread of any kind.
 * @param channelId - Discord snowflake ID of the channel.
 * @throws {Error} If the channel does not exist or is not a message-capable guild channel.
 */
export async function getTextChannel(channelId: string): Promise<GuildTextBasedChannel> {
  const id = validateId(channelId, "channel_id");
  const channel = await fetchChannelChecked(id);
  if (!channel || channel.isDMBased() || !channel.isTextBased())
    throw new Error(`Channel ${id} is not a message-capable guild channel or doesn't exist.`);
  return channel;
}

/**
 * Fetches a channel by ID and guarantees it is a non-thread guild channel
 * (text, voice, category, announcement, stage, forum…).
 * @param channelId - Discord snowflake ID of the channel.
 * @throws {Error} If the channel does not exist or is not a guild channel.
 */
export async function getGuildChannel(channelId: string): Promise<GuildChannel> {
  const id = validateId(channelId, "channel_id");
  const channel = await fetchChannelChecked(id);
  if (!channel || !(channel instanceof GuildChannel))
    throw new Error(`Channel ${id} is not a guild channel or doesn't exist.`);
  return channel;
}

/**
 * Parses permission flag names from an array or a JSON-encoded array string
 * (some MCP clients serialize arrays), validating every name against
 * PermissionsBitField.Flags so unknown flags fail with the culprit named.
 */
export function parsePermissionNames(value: string[] | string | undefined): string[] {
  if (value === undefined) return [];
  let names: unknown = value;
  if (typeof value === "string") {
    try {
      names = JSON.parse(value);
    } catch {
      throw new Error(
        `Invalid permission list: "${value}" is not a JSON array. Pass an array like ["SendMessages"].`,
      );
    }
  }
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string"))
    throw new Error("Invalid permission list: expected an array of permission flag names.");
  for (const name of names) {
    if (!(name in PermissionsBitField.Flags))
      throw new Error(
        `Unknown permission flag: "${name}". Use Discord PermissionsBitField flag names like "SendMessages".`,
      );
  }
  return names;
}

/**
 * Validates that a value is a proper Discord snowflake ID (17-20 digit number).
 * @param value - The raw value to validate.
 * @param label - A human-readable label used in the error message (e.g. "guild_id").
 * @returns The validated ID as a string.
 * @throws {Error} If the value is not a valid snowflake.
 */
export function validateId(value: unknown, label: string): string {
  const id = String(value ?? "");
  if (!/^\d{17,20}$/.test(id))
    throw new Error(`Invalid ${label}: "${id}". Must be a Discord snowflake ID (17-20 digits).`);
  return id;
}

/**
 * Converts a PermissionsBitField into a human-readable array of permission names.
 * @param perms - The bitfield to serialize.
 * @returns Array of permission flag names (e.g. ["SendMessages", "ViewChannel"]).
 */
export function serializePermissions(perms: Readonly<PermissionsBitField>): string[] {
  return Object.keys(PermissionsBitField.Flags).filter((flag) =>
    perms.has(flag as keyof typeof PermissionsBitField.Flags),
  );
}

/**
 * Builds a PermissionsBitField from an array of permission flag names.
 * Inverse of {@link serializePermissions}.
 * @param names - Permission flag names (e.g. ["SendMessages", "ViewChannel"]).
 * @returns A PermissionsBitField with those flags set.
 */
export function deserializePermissions(names: string[]): PermissionsBitField {
  return new PermissionsBitField(
    names.map((p) => PermissionsBitField.Flags[p as keyof typeof PermissionsBitField.Flags]),
  );
}

// ─── Permission and hierarchy preflight ────────────────────────────────────────

/**
 * Verifies the bot itself holds a permission in a guild before attempting an
 * action, so the failure names the missing permission instead of surfacing
 * Discord's generic 50013.
 *
 * The check is a preflight, not a guarantee: Discord remains the authority, and
 * a channel-level overwrite can still deny the action afterwards.
 */
export function assertBotPermission(
  guild: Guild,
  flag: keyof typeof PermissionsBitField.Flags,
  action: string,
): void {
  const me = guild.members.me;
  if (!me)
    throw new Error(`Cannot verify bot permissions in ${guild.name}: bot member not cached.`);
  if (!me.permissions.has(flag)) {
    throw new Error(
      `The bot lacks the ${flag} permission in "${guild.name}", which ${action} requires. Grant it in Server Settings > Roles, then retry.`,
    );
  }
}

/**
 * Verifies a target role sits strictly below the bot's highest role.
 *
 * Discord refuses role edits at or above the bot's own highest role; checking
 * first turns an opaque 50013 into an explanation of the hierarchy problem.
 */
export function assertRoleHierarchy(guild: Guild, target: Role, action: string): void {
  const me = guild.members.me;
  if (!me) throw new Error(`Cannot verify role hierarchy in ${guild.name}: bot member not cached.`);
  const highest = me.roles.highest;
  if (target.position >= highest.position) {
    throw new Error(
      `Cannot ${action} role "${target.name}" (position ${target.position}): it is at or above the bot's highest role "${highest.name}" (position ${highest.position}). Move the bot's role higher in Server Settings > Roles, then retry.`,
    );
  }
}

// ─── Image inputs ──────────────────────────────────────────────────────────────

/** Largest image accepted from a URL, base64 string or data URI: Discord's 10 MB upload cap. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Image formats Discord accepts for guild icons, banners, splashes and emoji. */
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Turns an image argument into bytes Discord will accept.
 *
 * Accepts an http(s) URL, a `data:image/...;base64,...` URI, or a bare base64
 * string. Only the four image types Discord documents are accepted, the size is
 * capped at 10 MB, and the response's `content-type` is checked before the bytes
 * are trusted: a URL that answers with HTML must not be forwarded as an icon.
 */
export async function resolveImageInput(value: string, label: string): Promise<Buffer> {
  const trimmed = value.trim();
  let buffer: Buffer;
  let contentType: string | undefined;

  if (/^https?:\/\//i.test(trimmed)) {
    const response = await fetch(trimmed, { redirect: "follow" });
    if (!response.ok)
      throw new Error(
        `Could not download the ${label}: HTTP ${response.status} from the provided URL.`,
      );
    contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_IMAGE_BYTES)
      throw new Error(
        `The ${label} at that URL is ${declaredLength} bytes, above the 10 MB limit.`,
      );
    buffer = Buffer.from(await response.arrayBuffer());
  } else {
    const match = /^data:([^;,]+);base64,(.*)$/is.exec(trimmed);
    if (match) {
      contentType = match[1]?.toLowerCase();
      buffer = Buffer.from(match[2] ?? "", "base64");
    } else {
      buffer = Buffer.from(trimmed, "base64");
    }
  }

  if (buffer.length === 0)
    throw new Error(
      `The ${label} is empty. Pass an https URL, a data: URI, or a base64-encoded image.`,
    );
  if (buffer.length > MAX_IMAGE_BYTES)
    throw new Error(`The ${label} is ${buffer.length} bytes, above Discord's 10 MB limit.`);

  const sniffed = sniffImageType(buffer);
  if (!sniffed)
    throw new Error(
      `The ${label} does not look like a PNG, JPEG, GIF or WebP image. Discord rejects anything else.`,
    );
  if (
    contentType &&
    contentType !== "application/octet-stream" &&
    !ALLOWED_IMAGE_TYPES.has(contentType)
  )
    throw new Error(
      `The URL for the ${label} served "${contentType}", not an image. Expected one of ${[...ALLOWED_IMAGE_TYPES].join(", ")}.`,
    );
  return buffer;
}

/** Reads the magic bytes of a buffer and returns the matching MIME type, if any. */
function sniffImageType(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return "image/jpeg";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii")))
    return "image/gif";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return null;
}

/** Fetches a guild by ID, enforcing the guild allow-list. */
export async function getGuild(guildId: string): Promise<Guild> {
  const id = validateId(guildId, "guild_id");
  assertAllowedGuild(id);
  return discord.guilds.fetch(id);
}
