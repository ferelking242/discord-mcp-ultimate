import {
  Events,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { discord, ensureConnected } from "../client.js";
import { createServer } from "../server.js";
import { loadConfig, type BotConfig } from "./config.js";
import { ReactionRoleHandlers, type Logger } from "./handlers.js";
import { createHttpControlPlane } from "./http.js";
import { SlidingWindowLimiter } from "./rateLimit.js";
import { ReactionRoleStore } from "./reactionRoles.js";

/**
 * Long-running bot entry point.
 *
 * One process, one gateway connection, one HTTP port. The MCP tool server and the
 * reaction-role bot share the same discord.js client — opening a second client with
 * the same token would give Discord two gateway sessions and double every event.
 *
 * `node dist/bot/index.js` runs this. `npm run bot` does the same after a build.
 */

const version: string = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"),
).version;

/** Console logger. Never receives a token: callers pass ids and messages only. */
const logger: Logger = {
  info: (msg, meta) => console.log(`[bot] ${msg}`, meta ? JSON.stringify(meta) : ""),
  warn: (msg, meta) => console.warn(`[bot] ${msg}`, meta ? JSON.stringify(meta) : ""),
  error: (msg, meta) => console.error(`[bot] ${msg}`, meta ? JSON.stringify(meta) : ""),
};

export interface RunningBot {
  stop(): Promise<void>;
}

/** Starts the bot and returns a handle that shuts it down cleanly. */
export async function startBot(cfg: BotConfig = loadConfig()): Promise<RunningBot> {
  const store = new ReactionRoleStore(cfg.reactionRolesFile);
  await store.load();
  // The MCP side writes this file when an agent builds a menu, so pick changes up
  // without a restart.
  const stopWatching = store.watch((count) =>
    logger.info("reaction-role file reloaded", { mappings: count }),
  );

  const handlers = new ReactionRoleHandlers({
    store,
    logger,
    mode: cfg.reactionMode,
    limiter: new SlidingWindowLimiter(cfg.reactionLimitPerMember, cfg.reactionWindowMs),
    isGuildAllowed: (id) =>
      cfg.allowedGuilds.length === 0 ? true : cfg.allowedGuilds.includes(id),
    welcome: { enabled: cfg.welcomeDm, message: cfg.welcomeMessage, inviteUrl: cfg.inviteUrl },
  });

  discord.on(Events.MessageReactionAdd, async (reaction, user) => {
    const outcome = await handlers
      .onReactionAdd(
        reaction as MessageReaction | PartialMessageReaction,
        user as User | PartialUser,
      )
      .catch((err: Error) => `failed: ${err.message}`);
    if (!outcome.startsWith("ignored") && !outcome.startsWith("no-op")) {
      logger.info("reaction add", { outcome });
    }
  });

  discord.on(Events.MessageReactionRemove, async (reaction, user) => {
    const outcome = await handlers
      .onReactionRemove(
        reaction as MessageReaction | PartialMessageReaction,
        user as User | PartialUser,
      )
      .catch((err: Error) => `failed: ${err.message}`);
    if (!outcome.startsWith("ignored") && !outcome.startsWith("no-op")) {
      logger.info("reaction remove", { outcome });
    }
  });

  discord.on(Events.GuildMemberAdd, async (member) => {
    const outcome = await handlers
      .onMemberJoin(member)
      .catch((err: Error) => `failed: ${err.message}`);
    if (!outcome.startsWith("ignored")) logger.info("member join", { outcome });
  });

  // 4014 is the one failure an operator can act on, and it is invisible otherwise.
  discord.on(Events.Error, (err: Error & { code?: number }) => {
    if (err.code === 4014) {
      logger.error(
        "gateway closed with 4014: enable the privileged intents (Guild Members, Message Content) in the Developer Portal, or set DISCORD_GUILD_MEMBERS=false / DISCORD_MESSAGE_CONTENT=false",
      );
    }
  });

  await ensureConnected();
  logger.info("connected to Discord", {
    user: discord.user?.tag,
    guilds: discord.guilds.cache.size,
    allowList: cfg.allowedGuilds.length ? cfg.allowedGuilds.join(",") : "all",
    reactionMode: cfg.reactionMode,
  });

  let http: ReturnType<typeof createHttpControlPlane> | undefined;
  if (cfg.httpEnabled) {
    http = createHttpControlPlane({
      host: cfg.httpHost,
      port: cfg.httpPort,
      token: cfg.httpToken!,
      logger,
      createMcpServer: () => createServer(version),
      getStatus: () => ({
        discord: {
          ready: discord.isReady(),
          user: discord.user?.tag,
          guilds: discord.guilds.cache.size,
        },
        reactionRoles: { mappings: store.all().length, mode: cfg.reactionMode },
      }),
    });
  }

  return {
    async stop() {
      logger.info("shutting down");
      stopWatching();
      await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
      await discord.destroy();
    },
  };
}

// Only self-start when executed directly, so importing this module in a test does
// not open a gateway connection.
const isMain = require.main === module;
if (isMain) {
  startBot()
    .then((bot) => {
      const shutdown = (signal: string) => {
        logger.info(`received ${signal}`);
        bot.stop().finally(() => process.exit(0));
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((err: Error) => {
      logger.error("bot failed to start", { error: err.message });
      process.exit(1);
    });
}
