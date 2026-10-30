import { dirname, join } from "node:path";

import type { BotConfig } from "./config.js";
import { GuildConfigStore } from "./guildConfig.js";
import { ReactionRoleStore } from "./reactionRoles.js";
import {
  CooldownStore,
  GiveawayStore,
  LevelStore,
  ModerationStore,
  StarboardStore,
  TempVoiceStore,
  TicketStore,
} from "./stores.js";
import type { Logger } from "./handlers.js";

/**
 * Every store the bot needs, opened and loaded once.
 *
 * Constructing them in one place is what lets the slash commands
 * and the event handlers share the same in-memory state. Two `GuildConfigStore`
 * instances over the same file would each hold their own copy and overwrite each
 * other's changes; one instance per process, and the file watcher handles the
 * other process.
 *
 * All the files live under one data directory so an operator backs up a single
 * folder, and so a Docker volume mount is one path rather than eight.
 */
export class BotServices {
  readonly guildConfig: GuildConfigStore;
  readonly reactionRoles: ReactionRoleStore;
  readonly moderation: ModerationStore;
  readonly levels: LevelStore;
  readonly tickets: TicketStore;
  readonly giveaways: GiveawayStore;
  readonly starboard: StarboardStore;
  readonly tempVoice: TempVoiceStore;
  readonly cooldowns: CooldownStore;

  constructor(
    readonly dataDir: string,
    readonly logger: Logger,
  ) {
    const path = (name: string) => join(dataDir, name);
    this.guildConfig = new GuildConfigStore(path("guild-config.json"));
    this.reactionRoles = new ReactionRoleStore(path("reaction-roles.json"));
    this.moderation = new ModerationStore(path("moderation-cases.json"));
    this.levels = new LevelStore(path("levels.json"));
    this.tickets = new TicketStore(path("tickets.json"));
    this.giveaways = new GiveawayStore(path("giveaways.json"));
    this.starboard = new StarboardStore(path("starboard.json"));
    this.tempVoice = new TempVoiceStore(path("temp-voice.json"));
    this.cooldowns = new CooldownStore(path("autoresponder-cooldowns.json"));
  }

  static fromConfig(cfg: BotConfig, logger: Logger): BotServices {
    // The data directory is the parent of the reaction-role file, so an existing
    // deployment that set only BOT_REACTION_ROLES_FILE keeps its file in place.
    const dataDir = cfg.dataDir ?? dirname(cfg.reactionRolesFile);
    return new BotServices(dataDir, logger);
  }

  /** Loads every store. A malformed file throws here, at startup, not mid-event. */
  async loadAll(): Promise<void> {
    await Promise.all([
      this.guildConfig.load(),
      this.reactionRoles.load(),
      this.moderation.load(),
      this.levels.load(),
      this.tickets.load(),
      this.giveaways.load(),
      this.starboard.load(),
      this.tempVoice.load(),
      this.cooldowns.load(),
    ]);
    this.logger.info("stores loaded", {
      dataDir: this.dataDir,
      configuredGuilds: this.guildConfig.guildIds().length,
      reactionRoleMenus: this.reactionRoles.all().length,
      openTickets: this.tickets.count((t) => t.status === "open"),
      activeGiveaways: this.giveaways.count((g) => !g.ended),
    });
  }

  /** Writes anything pending. Call on shutdown so a debounced XP batch is not lost. */
  async flushAll(): Promise<void> {
    await Promise.all([
      this.guildConfig.reloadIfChanged().then(() => undefined),
      this.levels.flush(),
      this.moderation.flush(),
      this.tickets.flush(),
      this.giveaways.flush(),
      this.starboard.flush(),
      this.tempVoice.flush(),
      this.cooldowns.flush(),
    ]);
  }

  /** A one-line summary for `/health` and `/status`. */
  stats(): Record<string, unknown> {
    return {
      configuredGuilds: this.guildConfig.guildIds().length,
      reactionRoleMenus: this.reactionRoles.all().length,
      openTickets: this.tickets.count((t) => t.status === "open"),
      activeGiveaways: this.giveaways.count((g) => !g.ended),
      moderationCases: this.moderation.count(),
      trackedMembers: this.levels.count(),
      starboardEntries: this.starboard.count(),
      tempChannels: this.tempVoice.count(),
    };
  }
}
