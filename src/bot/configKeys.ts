/**
 * The settings an operator can change from Discord.
 *
 * `/config` is generic: one subcommand per value *type* (`text`, `number`,
 * `role`, `channel`) rather than one subcommand per field. A field is added here
 * once and it becomes settable, with its own validation from the guild config
 * schema. Without the web panel there is no other way in, so this table is the
 * whole configuration surface.
 *
 * `path` is dotted: `welcome.message` becomes `{ welcome: { message } }` when the
 * patch is built. Keep it in sync with `guildConfigSchema` — a path that does not
 * exist there is rejected by the schema re-parse rather than written silently.
 */

export interface ConfigKey {
  /** Value passed as the slash-command choice. */
  value: string;
  /** What the operator reads in the picker. */
  label: string;
  /** Dotted path into the guild config. */
  path: string;
}

export const TEXT_KEYS: ConfigKey[] = [
  { value: "welcomeMessage", label: "Message de bienvenue", path: "welcome.message" },
  { value: "welcomeDm", label: "Message privé de bienvenue", path: "welcome.dmMessage" },
  { value: "goodbyeMessage", label: "Message de départ", path: "welcome.goodbyeMessage" },
  { value: "levelUpMessage", label: "Message de passage de niveau", path: "levels.levelUpMessage" },
  { value: "ticketOpen", label: "Message d'ouverture de ticket", path: "tickets.openMessage" },
  { value: "tempVoiceName", label: "Nom des salons vocaux", path: "tempVoice.nameTemplate" },
  { value: "starboardEmoji", label: "Émoji du starboard", path: "starboard.emoji" },
];

export const NUMBER_KEYS: ConfigKey[] = [
  {
    value: "autoroleMinAge",
    label: "Âge minimum du compte (jours)",
    path: "autorole.minAccountAgeDays",
  },
  { value: "xpMin", label: "XP minimum par message", path: "levels.xpMin" },
  { value: "xpMax", label: "XP maximum par message", path: "levels.xpMax" },
  { value: "xpCooldown", label: "Délai entre deux gains d'XP (s)", path: "levels.cooldownSeconds" },
  { value: "starboardThreshold", label: "Seuil d'étoiles", path: "starboard.threshold" },
  {
    value: "giveawayMinAge",
    label: "Âge minimum pour un concours (jours)",
    path: "giveaways.minAccountAgeDays",
  },
  {
    value: "giveawayDuration",
    label: "Durée par défaut d'un concours (min)",
    path: "giveaways.defaultDurationMinutes",
  },
  { value: "giveawayWinners", label: "Gagnants maximum", path: "giveaways.maxWinners" },
  { value: "ticketsMax", label: "Tickets ouverts maximum", path: "tickets.maxOpenPerGuild" },
  { value: "tempVoiceLimit", label: "Limite de places en vocal", path: "tempVoice.userLimit" },
  {
    value: "tempVoiceTimeout",
    label: "Délai avant suppression du vocal vide (s)",
    path: "tempVoice.emptyTimeoutSeconds",
  },
  {
    value: "timeoutMinutes",
    label: "Exclusion temporaire par défaut (min)",
    path: "moderation.defaultTimeoutMinutes",
  },
];

export const ROLE_KEYS: ConfigKey[] = [
  { value: "autorole", label: "Rôle automatique (ajoute)", path: "autorole.roleIds" },
  {
    value: "giveawayRequired",
    label: "Rôle requis pour un concours",
    path: "giveaways.requiredRoleId",
  },
  { value: "ticketSupport", label: "Rôle de support (ajoute)", path: "tickets.supportRoleIds" },
];

export const CHANNEL_KEYS: ConfigKey[] = [
  { value: "welcome", label: "Bienvenue", path: "welcome.channelId" },
  { value: "logging", label: "Journaux", path: "logging.channelId" },
  { value: "starboard", label: "Starboard", path: "starboard.channelId" },
  { value: "levelsAnnounce", label: "Annonces de niveau", path: "levels.announceChannelId" },
  { value: "ticketsPanel", label: "Panneau de tickets", path: "tickets.panelChannelId" },
  {
    value: "ticketsTranscript",
    label: "Transcriptions de tickets",
    path: "tickets.transcriptChannelId",
  },
  { value: "ticketsCategory", label: "Catégorie des tickets", path: "tickets.categoryId" },
  {
    value: "tempVoiceCategory",
    label: "Catégorie des vocaux temporaires",
    path: "tempVoice.categoryId",
  },
  { value: "moderationLog", label: "Journal de modération", path: "moderation.logChannelId" },
];

/** The feature toggles `/config set` accepts. */
export const FEATURE_KEYS = [
  { value: "welcome", label: "Bienvenue" },
  { value: "autorole", label: "Rôles automatiques" },
  { value: "levels", label: "Niveaux" },
  { value: "logging", label: "Journaux" },
  { value: "tickets", label: "Tickets" },
  { value: "giveaways", label: "Concours" },
  { value: "starboard", label: "Starboard" },
  { value: "tempVoice", label: "Vocal temporaire" },
  { value: "autoresponder", label: "Répondeur" },
  { value: "moderation", label: "Modération" },
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number]["value"];

/**
 * Turns a dotted path into the nested patch object `GuildConfigStore.patch`
 * expects. `welcome.message` becomes `{ welcome: { message: value } }`.
 */
export function nest(path: string, value: unknown): Record<string, unknown> {
  const [section, field] = path.split(".");
  return field ? { [section]: { [field]: value } } : { [section]: value };
}
