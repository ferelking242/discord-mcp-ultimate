import {
  EmbedBuilder,
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
import { FeatureHandlers } from "./eventHandlers.js";
import { ReactionRoleHandlers, type Logger } from "./handlers.js";
import { createHttpControlPlane } from "./http.js";
import { SlidingWindowLimiter } from "./rateLimit.js";
import { BotServices } from "./services.js";
import { handleCommand, registerCommands } from "./commands.js";

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
  const services = BotServices.fromConfig(cfg, logger);
  await services.loadAll();

  // The MCP side writes this file when an agent builds a menu, so pick changes up
  // without a restart.
  const stopWatchingRoles = services.reactionRoles.watch((count) =>
    logger.info("reaction-role file reloaded", { mappings: count }),
  );
  // Slash commands and the MCP tools both write here; each side watches for the other.
  const stopWatchingConfig = services.guildConfig.watch((guilds) =>
    logger.info("guild config reloaded", { guilds: guilds.length }),
  );

  const reactionRoles = new ReactionRoleHandlers({
    store: services.reactionRoles,
    logger,
    mode: cfg.reactionMode,
    limiter: new SlidingWindowLimiter(cfg.reactionLimitPerMember, cfg.reactionWindowMs),
    isGuildAllowed: (id) => cfg.allowedGuilds.length === 0 || cfg.allowedGuilds.includes(id),
    welcome: { enabled: cfg.welcomeDm, message: cfg.welcomeMessage, inviteUrl: cfg.inviteUrl },
  });

  const features = new FeatureHandlers({ client: discord, services, config: cfg, logger });
  features.attach(discord);

  discord.on(Events.MessageReactionAdd, async (reaction, user) => {
    const outcome = await reactionRoles
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
    const outcome = await reactionRoles
      .onReactionRemove(
        reaction as MessageReaction | PartialMessageReaction,
        user as User | PartialUser,
      )
      .catch((err: Error) => `failed: ${err.message}`);
    if (!outcome.startsWith("ignored") && !outcome.startsWith("no-op")) {
      logger.info("reaction remove", { outcome });
    }
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

  await registerCommands(discord, cfg.token, cfg.devGuildId, logger);
  discord.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleCommand(interaction, {
        services,
        logger,
      });
    } catch (err) {
      logger.error("command failed", {
        command: interaction.commandName,
        error: (err as Error).message,
      });
      // An expired interaction cannot be replied to; the failure is logged either way.
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "Une erreur est survenue." }).catch(() => null);
      } else {
        await interaction
          .reply({ content: "Une erreur est survenue.", ephemeral: true })
          .catch(() => null);
      }
    }
  });

  const sweeper = startGiveawaySweeper(services, logger);
  const reminderSweeper = startReminderSweeper(services, logger);
  const cooldownSweeper = setInterval(() => {
    void services.cooldowns.prune();
  }, 3_600_000);
  cooldownSweeper.unref?.();

  let http: ReturnType<typeof createHttpControlPlane> | undefined;
  if (cfg.httpEnabled) {
    http = createHttpControlPlane({
      host: cfg.httpHost,
      port: cfg.httpPort,
      token: cfg.httpToken!,
      logger,
      createMcpServer: () => createServer(version),
      extraHealth: () => ({ stores: services.stats() }),
      getStatus: () => ({
        discord: {
          ready: discord.isReady(),
          user: discord.user?.tag,
          guilds: discord.guilds.cache.size,
        },
        reactionRoles: { mappings: services.reactionRoles.all().length, mode: cfg.reactionMode },
        stores: services.stats(),
      }),
    });
  }

  return {
    async stop() {
      logger.info("shutting down");
      stopWatchingRoles();
      stopWatchingConfig();
      sweeper.stop();
      reminderSweeper.stop();
      clearInterval(cooldownSweeper);
      // Flush before closing: the XP store batches writes, and a restart should not
      // lose the last few minutes of activity.
      await services
        .flushAll()
        .catch((err: Error) =>
          logger.warn("could not flush stores on shutdown", { error: err.message }),
        );
      await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
      await discord.destroy();
    },
  };
}

/**
 * Draws giveaways whose deadline has passed.
 *
 * A poll rather than a per-giveaway timer: timers do not survive a restart, and a
 * giveaway that ends while the bot is down would otherwise never be drawn. Every
 * 20 seconds is well inside the resolution anyone notices.
 */
function startGiveawaySweeper(services: BotServices, logger: Logger): { stop(): void } {
  const timer = setInterval(() => {
    void (async () => {
      const due = services.giveaways.due();
      for (const giveaway of due) {
        try {
          const channel = await discord.channels.fetch(giveaway.channelId).catch(() => null);
          if (!channel?.isTextBased() || !("messages" in channel)) continue;
          const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);

          const pool = [...giveaway.entrants];
          const winners: string[] = [];
          const count = Math.min(giveaway.winnerCount, pool.length);
          for (let i = 0; i < count; i++) {
            const index = Math.floor(Math.random() * pool.length);
            winners.push(pool.splice(index, 1)[0]);
          }

          await services.giveaways.replace((g) => g.messageId === giveaway.messageId, {
            ...giveaway,
            ended: true,
            winnerIds: winners,
          });

          if (message) {
            await message
              .edit({
                content: "",
                embeds: [
                  new EmbedBuilder()
                    .setColor(0xf1c40f)
                    .setTitle(`🎉 ${giveaway.prize}`)
                    .setDescription(
                      winners.length
                        ? `Gagnant(s) : ${winners.map((id) => `<@${id}>`).join(", ")}`
                        : "Aucun participant — pas de gagnant.",
                    ),
                ],
                components: [],
              })
              .catch(() => null);
            if (winners.length) {
              await message
                .reply({
                  content: `Félicitations ${winners.map((id) => `<@${id}>`).join(", ")} ! Vous avez gagné **${giveaway.prize}**.`,
                  allowedMentions: { users: winners },
                })
                .catch(() => null);
            }
          }
          logger.info("giveaway drawn", { messageId: giveaway.messageId, winners: winners.length });
        } catch (err) {
          logger.error("giveaway draw failed", {
            messageId: giveaway.messageId,
            error: (err as Error).message,
          });
        }
      }
    })();
  }, 20_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * Fires due reminders.
 *
 * The same poll-not-timer reasoning as the giveaway sweeper: a reminder stored on
 * disk survives a restart, a `setTimeout` does not. One minute is the resolution
 * `/remind` advertises, so nothing is meaningfully late.
 */
function startReminderSweeper(services: BotServices, logger: Logger): { stop(): void } {
  const timer = setInterval(() => {
    void (async () => {
      for (const reminder of services.reminders.due()) {
        try {
          const channel = await discord.channels.fetch(reminder.channelId).catch(() => null);
          if (channel?.isTextBased() && "send" in channel) {
            await channel
              .send({
                content: `<@${reminder.userId}> rappel : ${reminder.text}`,
                allowedMentions: { users: [reminder.userId], parse: [] },
              })
              .catch(() => null);
          }
          await services.reminders.markFired(reminder.id);
        } catch (err) {
          logger.error("reminder failed", {
            id: reminder.id,
            error: (err as Error).message,
          });
        }
      }
      await services.reminders.pruneFired().catch(() => 0);
    })();
  }, 60_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
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
