import {
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type GuildMember,
  type TextChannel,
} from "discord.js";

import type { Logger } from "./handlers.js";
import { parseDuration } from "./features.js";
import type { BotServices } from "./services.js";
import type { CaseType } from "./stores.js";

/**
 * Moderation commands.
 *
 * Every action records a numbered case before it is announced, so the record
 * exists even if the Discord call then fails. A moderator who bans and sees an
 * error still wants the case on file: the alternative is a ban that happened
 * with no trace, or one that did not happen and no way to tell.
 *
 * The hierarchy is checked explicitly rather than left to Discord. A bot that
 * lets a moderator try to ban the server owner and reports "missing permissions"
 * is lying: the real reason is that the target outranks the bot, and that is what
 * the error says.
 */

export interface ModerationContext {
  services: BotServices;
  logger: Logger;
}

type Check = { ok: true } | { ok: false; reason: string };

/**
 * Whether the bot may act on this member, and the invoker may ask for it.
 *
 * `invoker` is checked against the target as well: a moderator must not be able
 * to act on someone at or above their own highest role, which is Discord's own
 * rule and the one people are most surprised to see enforced.
 */
export function checkTarget(
  me: GuildMember,
  target: GuildMember,
  invoker: GuildMember,
  action: "ban" | "kick" | "timeout" | "warn",
): Check {
  if (target.id === me.id) return { ok: false, reason: "je ne peux pas m'appliquer une sanction." };
  if (target.id === target.guild.ownerId) {
    return { ok: false, reason: "le propriétaire du serveur est intouchable." };
  }
  if (target.id === invoker.id) {
    return { ok: false, reason: "vous ne pouvez pas vous sanctionner vous-même." };
  }
  if (!target.manageable) {
    return {
      ok: false,
      reason: `je n'ai pas la permission sur ${target.user.tag} : son rôle le plus haut est au-dessus du mien.`,
    };
  }
  // A moderator may only act on members strictly below their own highest role.
  if (invoker.id !== target.guild.ownerId) {
    const invokerTop = invoker.roles.highest.position;
    if (target.roles.highest.position >= invokerTop) {
      return {
        ok: false,
        reason: `${target.user.tag} a un rôle égal ou supérieur au vôtre.`,
      };
    }
  }
  if (action === "ban" && !me.permissions.has(PermissionFlagsBits.BanMembers)) {
    return { ok: false, reason: "il me manque la permission « Bannir des membres »." };
  }
  if (action === "kick" && !me.permissions.has(PermissionFlagsBits.KickMembers)) {
    return { ok: false, reason: "il me manque la permission « Expulser des membres »." };
  }
  if (
    (action === "timeout" || action === "warn") &&
    !me.permissions.has(PermissionFlagsBits.ModerateMembers)
  ) {
    return { ok: false, reason: "il me manque la permission « Exclure temporairement »." };
  }
  return { ok: true };
}

/** The colour each case type carries in the moderation log. */
const CASE_COLOURS: Record<string, number> = {
  ban: 0xed4245,
  unban: 0x57f287,
  kick: 0xe67e22,
  timeout: 0xfee75c,
  untimeout: 0x57f287,
  warn: 0xfaa61a,
  note: 0x99aab5,
  softban: 0xe67e22,
  purge: 0x99aab5,
};

/**
 * Records a case and returns its number.
 *
 * This also posts to the configured moderation log, which is the only thing that
 * gives `moderation.logChannelId` an effect. The log entry is best-effort: a
 * deleted or unreadable channel must not stop the sanction itself.
 */
export async function recordCase(
  services: BotServices,
  opts: {
    guildId: string;
    type: CaseType;
    targetId: string;
    targetTag: string;
    moderatorId: string;
    moderatorTag: string;
    reason: string;
    durationMs?: number | null;
    /** The client, to reach the log channel. */
    client?: ChatInputCommandInteraction["client"];
  },
): Promise<number> {
  const number = services.moderation.nextNumber(opts.guildId);
  const createdAt = new Date().toISOString();
  await services.moderation.add({
    number,
    guildId: opts.guildId,
    type: opts.type,
    targetId: opts.targetId,
    targetTag: opts.targetTag,
    moderatorId: opts.moderatorId,
    moderatorTag: opts.moderatorTag,
    reason: opts.reason,
    durationMs: opts.durationMs ?? null,
    createdAt,
    active: true,
  });

  await postToLog(services, opts, number, createdAt);
  return number;
}

/** Posts one case to the moderation log, if one is configured and reachable. */
async function postToLog(
  services: BotServices,
  opts: {
    guildId: string;
    type: CaseType;
    targetTag: string;
    moderatorTag: string;
    reason: string;
    durationMs?: number | null;
    client?: ChatInputCommandInteraction["client"];
  },
  number: number,
  createdAt: string,
): Promise<void> {
  const channelId = services.guildConfig.get(opts.guildId).moderation.logChannelId;
  if (!channelId || !opts.client) return;
  const channel = await opts.client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;
  await channel
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(CASE_COLOURS[opts.type] ?? 0x5865f2)
          .setTitle(`Cas #${number} — ${opts.type}`)
          .addFields(
            { name: "Membre", value: opts.targetTag, inline: true },
            { name: "Modérateur", value: opts.moderatorTag, inline: true },
            { name: "Raison", value: opts.reason.slice(0, 1000) },
          )
          .setTimestamp(new Date(createdAt)),
      ],
      allowedMentions: { parse: [] },
    })
    .catch(() => null);
}

/** DMs the member about the action. A closed DM is not an error. */
export async function notifyTarget(
  services: BotServices,
  guildId: string,
  member: GuildMember,
  text: string,
): Promise<void> {
  if (!services.guildConfig.get(guildId).moderation.dmOnAction) return;
  await member.send(text).catch(() => null);
}

/**
 * Handles every moderation command. Returns false when the command is not one of
 * ours, so the caller can fall through.
 */
export async function handleModeration(
  interaction: ChatInputCommandInteraction,
  ctx: ModerationContext,
): Promise<boolean> {
  const name = interaction.commandName;
  if (
    ![
      "ban",
      "kick",
      "timeout",
      "untimeout",
      "purge",
      "slowmode",
      "lock",
      "unlock",
      "note",
    ].includes(name)
  ) {
    return false;
  }

  const guildId = interaction.guildId!;
  const guild = interaction.guild!;

  if (!ctx.services.guildConfig.get(guildId).moderation.enabled) {
    await interaction.reply({
      content:
        "La modération est désactivée sur ce serveur. Activez-la avec `/config set fonction:moderation actif:true`.",
      ephemeral: true,
    });
    return true;
  }

  const me = guild.members.me;
  if (!me) {
    await interaction.reply({ content: "Je ne peux pas lire mes permissions.", ephemeral: true });
    return true;
  }

  // ── Salon : purge, slowmode, lock, unlock ──────────────────────────────────
  if (name === "purge") {
    const count = interaction.options.getInteger("nombre", true);
    const channel = interaction.channel;
    if (!channel?.isTextBased() || !("bulkDelete" in channel)) {
      await interaction.reply({ content: "Ce salon ne permet pas la purge.", ephemeral: true });
      return true;
    }
    if (!me.permissionsIn(channel).has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({
        content: "Il me manque « Gérer les messages » dans ce salon.",
        ephemeral: true,
      });
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    // Discord refuses bulkDelete above 100 and on messages older than 14 days.
    const deleted = await (channel as TextChannel)
      .bulkDelete(Math.min(count, 100), true)
      .catch(() => null);
    if (!deleted) {
      await interaction.editReply({ content: "La suppression a échoué." });
      return true;
    }
    await recordCase(ctx.services, {
      guildId,
      type: "purge",
      targetId: channel.id,
      targetTag: `#${(channel as TextChannel).name}`,
      moderatorId: interaction.user.id,
      moderatorTag: interaction.user.tag,
      reason: `Purge de ${deleted.size} message(s)`,
      client: interaction.client,
    });
    await interaction.editReply({ content: `${deleted.size} message(s) supprimé(s).` });
    return true;
  }

  if (name === "slowmode") {
    const seconds = interaction.options.getInteger("secondes", true);
    const channel = interaction.channel;
    if (!channel || !("setRateLimitPerUser" in channel)) {
      await interaction.reply({ content: "Ce salon ne gère pas le mode lent.", ephemeral: true });
      return true;
    }
    if (!me.permissionsIn(channel).has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({
        content: "Il me manque « Gérer les salons » ici.",
        ephemeral: true,
      });
      return true;
    }
    await channel.setRateLimitPerUser(seconds);
    await interaction.reply({
      content: seconds === 0 ? "Mode lent désactivé." : `Mode lent : ${seconds} s.`,
      ephemeral: true,
    });
    return true;
  }

  if (name === "lock" || name === "unlock") {
    const channel = interaction.channel;
    if (!channel || !("permissionOverwrites" in channel)) {
      await interaction.reply({ content: "Ce salon ne se verrouille pas.", ephemeral: true });
      return true;
    }
    if (!me.permissionsIn(channel).has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({
        content: "Il me manque « Gérer les salons » ici.",
        ephemeral: true,
      });
      return true;
    }
    const everyone = guild.roles.everyone;
    await channel.permissionOverwrites.edit(everyone, {
      SendMessages: name === "lock" ? false : null,
    });
    await interaction.reply({
      content: name === "lock" ? `🔒 ${channel} verrouillé.` : `🔓 ${channel} déverrouillé.`,
      ephemeral: true,
    });
    return true;
  }

  // ── Membre : ban, kick, timeout, untimeout, note ───────────────────────────
  const user = interaction.options.getUser("membre", true);
  const reason = interaction.options.getString("raison") ?? "Aucune raison fournie.";
  const member = await guild.members.fetch(user.id).catch(() => null);

  if (name === "note") {
    // A note is about a member who may not be present, so it does not need them.
    const number = await recordCase(ctx.services, {
      guildId,
      type: "note",
      targetId: user.id,
      targetTag: user.tag,
      moderatorId: interaction.user.id,
      moderatorTag: interaction.user.tag,
      reason,
      client: interaction.client,
    });
    await interaction.reply({ content: `Note enregistrée — cas #${number}.`, ephemeral: true });
    return true;
  }

  if (!member) {
    await interaction.reply({ content: "Ce membre n'est pas sur le serveur.", ephemeral: true });
    return true;
  }
  const invoker = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!invoker) {
    await interaction.reply({ content: "Je ne peux pas lire votre profil.", ephemeral: true });
    return true;
  }

  if (name === "ban") {
    const check = checkTarget(me, member, invoker, "ban");
    if (!check.ok) {
      await interaction.reply({ content: check.reason, ephemeral: true });
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const number = await recordCase(ctx.services, {
      guildId,
      type: "ban",
      targetId: user.id,
      targetTag: user.tag,
      moderatorId: interaction.user.id,
      moderatorTag: interaction.user.tag,
      reason,
      client: interaction.client,
    });
    await notifyTarget(
      ctx.services,
      guildId,
      member,
      `Vous avez été banni de **${guild.name}** : ${reason}`,
    );
    try {
      await member.ban({ reason: `${interaction.user.tag} : ${reason}` });
    } catch (err) {
      await interaction.editReply({
        content: `Cas #${number} enregistré, mais le bannissement a échoué : ${(err as Error).message}`,
      });
      return true;
    }
    await interaction.editReply({ content: `${user.tag} banni — cas #${number}.` });
    return true;
  }

  if (name === "kick") {
    const check = checkTarget(me, member, invoker, "kick");
    if (!check.ok) {
      await interaction.reply({ content: check.reason, ephemeral: true });
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const number = await recordCase(ctx.services, {
      guildId,
      type: "kick",
      targetId: user.id,
      targetTag: user.tag,
      moderatorId: interaction.user.id,
      moderatorTag: interaction.user.tag,
      reason,
      client: interaction.client,
    });
    await notifyTarget(
      ctx.services,
      guildId,
      member,
      `Vous avez été expulsé de **${guild.name}** : ${reason}`,
    );
    try {
      await member.kick(`${interaction.user.tag} : ${reason}`);
    } catch (err) {
      await interaction.editReply({
        content: `Cas #${number} enregistré, mais l'expulsion a échoué : ${(err as Error).message}`,
      });
      return true;
    }
    await interaction.editReply({ content: `${user.tag} expulsé — cas #${number}.` });
    return true;
  }

  if (name === "timeout") {
    const check = checkTarget(me, member, invoker, "timeout");
    if (!check.ok) {
      await interaction.reply({ content: check.reason, ephemeral: true });
      return true;
    }
    const raw = interaction.options.getString("duree");
    const durationMs = raw
      ? parseDuration(raw)
      : ctx.services.guildConfig.get(guildId).moderation.defaultTimeoutMinutes * 60_000;
    if (durationMs === null) {
      await interaction.reply({ content: `Durée invalide : « ${raw} ».`, ephemeral: true });
      return true;
    }
    // Discord caps a timeout at 28 days.
    const capped = Math.min(durationMs, 28 * 86_400_000);
    await interaction.deferReply({ ephemeral: true });
    const number = await recordCase(ctx.services, {
      guildId,
      type: "timeout",
      targetId: user.id,
      targetTag: user.tag,
      moderatorId: interaction.user.id,
      moderatorTag: interaction.user.tag,
      reason,
      durationMs: capped,
      client: interaction.client,
    });
    await notifyTarget(
      ctx.services,
      guildId,
      member,
      `Vous êtes exclu temporairement de **${guild.name}** : ${reason}`,
    );
    try {
      await member.timeout(capped, `${interaction.user.tag} : ${reason}`);
    } catch (err) {
      await interaction.editReply({
        content: `Cas #${number} enregistré, mais l'exclusion a échoué : ${(err as Error).message}`,
      });
      return true;
    }
    const minutes = Math.round(capped / 60_000);
    await interaction.editReply({
      content: `${user.tag} exclu ${minutes} minute(s) — cas #${number}.`,
    });
    return true;
  }

  if (name === "untimeout") {
    const check = checkTarget(me, member, invoker, "timeout");
    if (!check.ok) {
      await interaction.reply({ content: check.reason, ephemeral: true });
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const number = await recordCase(ctx.services, {
      guildId,
      type: "untimeout",
      targetId: user.id,
      targetTag: user.tag,
      moderatorId: interaction.user.id,
      moderatorTag: interaction.user.tag,
      reason,
      client: interaction.client,
    });
    try {
      await member.timeout(null, `${interaction.user.tag} : ${reason}`);
    } catch (err) {
      await interaction.editReply({
        content: `Cas #${number} enregistré, mais la levée a échoué : ${(err as Error).message}`,
      });
      return true;
    }
    // The original timeout case is closed, so `activeFor` reflects reality.
    const open = ctx.services.moderation
      .activeFor(guildId, user.id)
      .filter((c) => c.type === "timeout");
    for (const c of open) {
      await ctx.services.moderation.replace((x) => x.guildId === guildId && x.number === c.number, {
        ...c,
        active: false,
      });
    }
    await interaction.editReply({ content: `Exclusion levée pour ${user.tag} — cas #${number}.` });
    return true;
  }

  return false;
}
