import { z } from "zod";

/**
 * Configuration for the long-running bot process.
 *
 * Everything is read from the environment so the same image can run on a server
 * without a rebuild. Parsing is strict: a malformed value fails at startup with a
 * readable message rather than at the first reaction at 3am.
 */

const bool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? defaultValue : !/^(false|0|no|off)$/i.test(v.trim())));

const int = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? defaultValue : Number(v)))
    .refine((n) => Number.isInteger(n) && n > 0, "must be a positive integer");

const schema = z.object({
  /** Discord bot token. Never logged, never written to disk. */
  token: z.string({ error: "DISCORD_TOKEN is required to run the bot" }).min(1),
  /** Optional allow-list of guild ids. Empty means every guild the bot is in. */
  allowedGuilds: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /** Reaction-role mapping file. Created on first write. */
  reactionRolesFile: z.string().default(".data/reaction-roles.json"),
  /**
   * Directory holding every state file. Defaults to the directory of
   * `reactionRolesFile`, so a deployment that already set that path keeps it.
   */
  dataDir: z.string().optional(),
  /**
   * `toggle` removes the role when the reaction is removed, `add-only` keeps the
   * role once granted. Toggle is the default because it is what members expect
   * from a reaction menu.
   */
  reactionMode: z.enum(["toggle", "add-only"]).default("toggle"),
  /** Per-member reaction actions allowed inside the window below. */
  reactionLimitPerMember: int(10),
  reactionWindowMs: int(10_000),
  /** Send a DM to members who join. Off by default: it can look like spam. */
  welcomeDm: bool(false),
  welcomeMessage: z
    .string()
    .default(
      "Welcome to the server! Head to the onboarding channels to pick your language and interests.",
    ),
  /** Optional invite URL appended to the welcome DM. */
  inviteUrl: z.string().optional(),
  /** Presence text shown under the bot name. */
  status: z.string().default("Watchtower"),
  /**
   * MCP over HTTP. Off unless explicitly enabled: the port holds a bot token and
   * the destructive tool surface, so it must never be exposed by accident.
   */
  httpEnabled: bool(false),
  httpHost: z.string().default("127.0.0.1"),
  httpPort: int(3000),
  /**
   * Bearer token required by every HTTP route except `/health`. Without it the
   * control plane would be an unauthenticated remote-admin endpoint.
   */
  httpToken: z.string().optional(),

  // ── Slash commands ──────────────────────────────────────────────────────────
  /**
   * Registers commands to this guild only, which takes effect immediately. Unset
   * means global registration, which Discord can take an hour to propagate.
   */
  devGuildId: z.string().optional(),
});

export type BotConfig = z.infer<typeof schema> & { token: string };

/** Parses the process environment, throwing a readable error on a bad value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const parsed = schema.safeParse({
    token: env.DISCORD_TOKEN,
    allowedGuilds: env.DISCORD_ALLOWED_GUILDS,
    reactionRolesFile: env.BOT_REACTION_ROLES_FILE,
    dataDir: env.BOT_DATA_DIR,
    reactionMode: env.BOT_REACTION_MODE,
    reactionLimitPerMember: env.BOT_REACTION_LIMIT,
    reactionWindowMs: env.BOT_REACTION_WINDOW_MS,
    welcomeDm: env.BOT_WELCOME_DM,
    welcomeMessage: env.BOT_WELCOME_MESSAGE,
    inviteUrl: env.BOT_INVITE_URL,
    status: env.BOT_STATUS,
    httpEnabled: env.MCP_HTTP_ENABLED,
    httpHost: env.MCP_HTTP_HOST,
    httpPort: env.MCP_HTTP_PORT,
    httpToken: env.MCP_HTTP_TOKEN,
    devGuildId: env.DISCORD_DEV_GUILD,
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "env"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid bot configuration — ${detail}`);
  }
  const cfg = parsed.data;
  if (cfg.httpEnabled && !cfg.httpToken) {
    throw new Error(
      "MCP_HTTP_TOKEN is required when MCP_HTTP_ENABLED is on: the HTTP control plane would otherwise be reachable without authentication.",
    );
  }
  return cfg;
}
