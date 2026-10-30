import { randomUUID } from "node:crypto";

import {
  ChannelType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type User,
} from "discord.js";

import { accountAgeDays, parseDuration, truncate } from "./features.js";
import type { Logger } from "./handlers.js";
import type { BotServices } from "./services.js";

/**
 * Utility commands.
 *
 * None of these change server state, which is the point: the administrative
 * surface is in `moderation.ts` and `commands.ts`, and a member asking for their
 * own avatar should not need a permission for it.
 */

export interface UtilityContext {
  services: BotServices;
  logger: Logger;
}

/** Formats a duration in ms as a short French string. */
export function humanDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days} j`);
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (parts.length === 0) parts.push(`${seconds} s`);
  return parts.join(" ");
}

/** The `/serverinfo` embed. Built from the gateway cache, no API call needed. */
export function serverInfoEmbed(guild: Guild): EmbedBuilder {
  const owner = guild.ownerId ? `<@${guild.ownerId}>` : "inconnu";
  const channels = guild.channels.cache;
  const counts = {
    text: channels.filter((c) => c.type === ChannelType.GuildText).size,
    voice: channels.filter((c) => c.type === ChannelType.GuildVoice).size,
    category: channels.filter((c) => c.type === ChannelType.GuildCategory).size,
    forum: channels.filter((c) => c.type === ChannelType.GuildForum).size,
  };
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(guild.name)
    .setThumbnail(guild.iconURL({ size: 256 }))
    .addFields(
      { name: "Identifiant", value: guild.id, inline: true },
      { name: "Propriétaire", value: owner, inline: true },
      {
        name: "Créé le",
        value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`,
        inline: true,
      },
      { name: "Membres", value: String(guild.memberCount), inline: true },
      { name: "Rôles", value: String(guild.roles.cache.size), inline: true },
      {
        name: "Salons",
        value: `${counts.text} texte, ${counts.voice} vocal, ${counts.category} catégories, ${counts.forum} forums`,
      },
      {
        name: "Niveau de vérification",
        value: String(guild.verificationLevel),
        inline: true,
      },
      {
        name: "Boosts",
        value: `${guild.premiumSubscriptionCount ?? 0} (niveau ${guild.premiumTier})`,
        inline: true,
      },
    );
}

/** The `/userinfo` embed. */
export function userInfoEmbed(member: GuildMember, user: User): EmbedBuilder {
  const roles = member.roles.cache
    .filter((r) => r.id !== member.guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => `<@&${r.id}>`);
  return new EmbedBuilder()
    .setColor(member.displayColor || 0x5865f2)
    .setTitle(user.tag)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "Identifiant", value: user.id, inline: true },
      { name: "Surnom", value: member.nickname ?? "aucun", inline: true },
      { name: "Bot", value: user.bot ? "oui" : "non", inline: true },
      {
        name: "Compte créé",
        value: `<t:${Math.floor(user.createdTimestamp / 1000)}:D> (${accountAgeDays(user.createdAt)} j)`,
        inline: true,
      },
      {
        name: "A rejoint",
        value: member.joinedTimestamp
          ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>`
          : "inconnu",
        inline: true,
      },
      {
        name: `Rôles (${roles.length})`,
        value: roles.length ? truncate(roles.slice(0, 20).join(" "), 1000) : "aucun",
      },
    );
}

/**
 * Handles the utility commands. Returns false when the command is not one of ours.
 */
export async function handleUtility(
  interaction: ChatInputCommandInteraction,
  ctx: UtilityContext,
): Promise<boolean> {
  const name = interaction.commandName;
  if (!["serverinfo", "userinfo", "avatar", "poll", "remind", "afk", "afk-list"].includes(name)) {
    return false;
  }
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "Commande réservée aux serveurs.", ephemeral: true });
    return true;
  }

  if (name === "serverinfo") {
    await interaction.reply({ embeds: [serverInfoEmbed(guild)] });
    return true;
  }

  if (name === "userinfo" || name === "avatar") {
    const target = interaction.options.getUser("membre") ?? interaction.user;
    const member = await guild.members.fetch(target.id).catch(() => null);
    if (name === "avatar") {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`Avatar de ${target.tag}`)
            .setImage(target.displayAvatarURL({ size: 1024 })),
        ],
      });
      return true;
    }
    if (!member) {
      await interaction.reply({ content: "Ce membre n'est pas sur le serveur.", ephemeral: true });
      return true;
    }
    await interaction.reply({ embeds: [userInfoEmbed(member, target)] });
    return true;
  }

  if (name === "poll") {
    const question = interaction.options.getString("question", true);
    const rawOptions = interaction.options.getString("options");
    // Two to ten choices, split on `|`. A poll with one choice is not a poll.
    const choices = rawOptions
      ? rawOptions
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 10)
      : ["Oui", "Non"];
    if (choices.length < 2) {
      await interaction.reply({
        content: "Il faut au moins deux options, séparées par `|`.",
        ephemeral: true,
      });
      return true;
    }
    // Discord renders a poll natively; no need to count reactions ourselves.
    await interaction.reply({
      poll: {
        question: { text: truncate(question, 300) },
        answers: choices.map((text) => ({ text: truncate(text, 55) })),
        duration: 24,
        allowMultiselect: false,
      },
    });
    return true;
  }

  if (name === "remind") {
    const raw = interaction.options.getString("duree", true);
    const text = interaction.options.getString("texte", true);
    const durationMs = parseDuration(raw);
    if (durationMs === null || durationMs <= 0) {
      await interaction.reply({ content: `Durée invalide : « ${raw} ».`, ephemeral: true });
      return true;
    }
    // A cap keeps a typo like `1000d` from parking a reminder for years.
    if (durationMs > 365 * 86_400_000) {
      await interaction.reply({ content: "Un an maximum.", ephemeral: true });
      return true;
    }
    const dueAt = Date.now() + durationMs;
    await ctx.services.reminders.addReminder({
      id: randomUUID(),
      guildId: guild.id,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      text: truncate(text, 1000),
      dueAt,
      createdAt: new Date().toISOString(),
      fired: false,
    });
    await interaction.reply({
      content: `Rappel dans ${humanDuration(durationMs)} (<t:${Math.floor(dueAt / 1000)}:R>).`,
      ephemeral: true,
    });
    return true;
  }

  if (name === "afk") {
    const reason = interaction.options.getString("raison") ?? "AFK";
    const existing = ctx.services.afk.for(guild.id, interaction.user.id);
    await ctx.services.afk.set(guild.id, interaction.user.id, truncate(reason, 200));
    await interaction.reply({
      content: existing
        ? `Raison AFK mise à jour : ${truncate(reason, 200)}`
        : `Vous êtes absent : ${truncate(reason, 200)}. Je le signalerai si on vous mentionne.`,
      ephemeral: true,
    });
    return true;
  }

  if (name === "afk-list") {
    const records = ctx.services.afk.inGuild(guild.id);
    if (records.length === 0) {
      await interaction.reply({ content: "Personne n'est absent.", ephemeral: true });
      return true;
    }
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("Membres absents")
          .setDescription(
            records
              .slice(0, 30)
              .map(
                (r) =>
                  `<@${r.userId}> — ${truncate(r.reason, 80)} (<t:${Math.floor(new Date(r.since).getTime() / 1000)}:R>)`,
              )
              .join("\n"),
          ),
      ],
      ephemeral: true,
    });
    return true;
  }

  return false;
}
