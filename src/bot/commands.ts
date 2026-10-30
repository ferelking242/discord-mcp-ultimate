import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";

import { levelProgress, parseDuration, truncate } from "./features.js";
import type { Logger } from "./handlers.js";
import type { BotServices } from "./services.js";

/**
 * Slash commands.
 *
 * Registration is deliberately a single `PUT` of the whole command list. A partial
 * update would leave commands an older build registered, and a stale `/ban` in the
 * picker is worse than a missing one. Guild-scoped commands are used when
 * `DISCORD_DEV_GUILD` is set, which makes iteration instant; otherwise they are
 * global and Discord takes up to an hour to propagate them.
 *
 * Every command replies ephemerally unless the reply is meant for the channel, so
 * an operator experimenting does not spam the server.
 */

export interface CommandContext {
  services: BotServices;
  logger: Logger;
  /** Operator-facing commands require this role or Manage Server. */
  adminRoleIds: string[];
}

const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Vérifie que le bot répond."),
  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Affiche votre niveau ou celui d'un membre.")
    .addUserOption((o) => o.setName("membre").setDescription("Membre à consulter.")),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Classement du serveur."),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Avertit un membre.")
    .addUserOption((o) => o.setName("membre").setDescription("Membre à avertir.").setRequired(true))
    .addStringOption((o) => o.setName("raison").setDescription("Raison.").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder()
    .setName("cases")
    .setDescription("Historique de modération d'un membre.")
    .addUserOption((o) =>
      o.setName("membre").setDescription("Membre à consulter.").setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Lance un concours.")
    .addStringOption((o) =>
      o.setName("lot").setDescription("Ce qui est à gagner.").setRequired(true),
    )
    .addStringOption((o) => o.setName("duree").setDescription("Durée, par exemple 1h, 2d, 30m."))
    .addIntegerOption((o) =>
      o.setName("gagnants").setDescription("Nombre de gagnants.").setMinValue(1).setMaxValue(50),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents),
  new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("Publie le panneau d'ouverture de tickets dans ce salon.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Affiche ou modifie la configuration du serveur.")
    .addSubcommand((s) => s.setName("show").setDescription("Affiche la configuration actuelle."))
    .addSubcommand((s) =>
      s
        .setName("set")
        .setDescription("Active ou désactive une fonctionnalité.")
        .addStringOption((o) =>
          o
            .setName("fonction")
            .setDescription("Fonctionnalité à modifier.")
            .setRequired(true)
            .addChoices(
              { name: "Bienvenue", value: "welcome" },
              { name: "Rôles automatiques", value: "autorole" },
              { name: "Niveaux", value: "levels" },
              { name: "Journaux", value: "logging" },
              { name: "Tickets", value: "tickets" },
              { name: "Concours", value: "giveaways" },
              { name: "Starboard", value: "starboard" },
              { name: "Vocal temporaire", value: "tempVoice" },
              { name: "Répondeur", value: "autoresponder" },
            ),
        )
        .addBooleanOption((o) =>
          o.setName("actif").setDescription("Activer ou désactiver.").setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("channel")
        .setDescription("Définit le salon d'une fonctionnalité.")
        .addStringOption((o) =>
          o
            .setName("fonction")
            .setDescription("Fonctionnalité.")
            .setRequired(true)
            .addChoices(
              { name: "Bienvenue", value: "welcome" },
              { name: "Journaux", value: "logging" },
              { name: "Starboard", value: "starboard" },
              { name: "Annonces de niveau", value: "levelsAnnounce" },
              { name: "Panneau de tickets", value: "ticketsPanel" },
              { name: "Transcriptions", value: "ticketsTranscript" },
            ),
        )
        .addChannelOption((o) =>
          o
            .setName("salon")
            .setDescription("Salon à utiliser.")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("permissions")
    .setDescription("Diagnostique les permissions du bot sur ce serveur."),
].map((c) => c.toJSON());

/** Registers the command list with Discord, replacing whatever was there. */
export async function registerCommands(
  client: Client,
  token: string,
  devGuildId: string | undefined,
  logger: Logger,
): Promise<void> {
  if (!client.application) return;
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    if (devGuildId) {
      await rest.put(Routes.applicationGuildCommands(client.application.id, devGuildId), {
        body: commands,
      });
      logger.info("slash commands registered", { scope: "guild", guildId: devGuildId });
      return;
    }
    await rest.put(Routes.applicationCommands(client.application.id), { body: commands });
    logger.info("slash commands registered", { scope: "global", count: commands.length });
  } catch (err) {
    // A failed registration must not stop the bot: the features still work, only
    // the picker is empty, and the operator sees why.
    logger.error("could not register slash commands", { error: (err as Error).message });
  }
}

/**
 * The command handler. Returns true when the interaction was one of ours.
 *
 * Each branch replies within Discord's three-second window; anything slower
 * defers first, which is why `/giveaway` and `/ticket-panel` defer before touching
 * the API.
 */
export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<boolean> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "Ces commandes ne fonctionnent que sur un serveur.",
      ephemeral: true,
    });
    return true;
  }
  const cfg = ctx.services.guildConfig.get(guildId);

  switch (interaction.commandName) {
    case "ping": {
      const sent = Date.now();
      await interaction.reply({ content: "Pong…", ephemeral: true });
      await interaction.editReply({
        content: `Pong — ${Date.now() - sent} ms (WebSocket ${Math.round(interaction.client.ws.ping)} ms)`,
      });
      return true;
    }

    case "rank": {
      const target = interaction.options.getUser("membre") ?? interaction.user;
      const record = ctx.services.levels.for(guildId, target.id);
      const progress = levelProgress(record.xp);
      const rank = ctx.services.levels.rank(guildId, target.id);
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setAuthor({ name: target.tag, iconURL: target.displayAvatarURL() })
            .addFields(
              { name: "Niveau", value: String(progress.level), inline: true },
              { name: "XP", value: String(record.xp), inline: true },
              { name: "Rang", value: rank > 0 ? `#${rank}` : "non classé", inline: true },
              {
                name: "Progression",
                value: `${progress.intoLevel} / ${progress.needed} (${progress.percent} %)`,
              },
            ),
        ],
      });
      return true;
    }

    case "leaderboard": {
      const top = ctx.services.levels.leaderboard(guildId, 10);
      if (top.length === 0) {
        await interaction.reply({
          content: "Aucun membre n'a encore gagné d'XP.",
          ephemeral: true,
        });
        return true;
      }
      const lines = top.map(
        (r, i) => `**${i + 1}.** <@${r.userId}> — niveau ${r.level} (${r.xp} XP)`,
      );
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("Classement")
            .setDescription(lines.join("\n")),
        ],
      });
      return true;
    }

    case "warn": {
      const user = interaction.options.getUser("membre", true);
      const reason = interaction.options.getString("raison", true);
      // A fetched member, not the interaction's resolved one: only the fetched
      // object has `send`, which is how the warning reaches the member.
      const member = await interaction.guild?.members.fetch(user.id).catch(() => null);
      if (!member) {
        await interaction.reply({
          content: "Ce membre n'est pas sur le serveur.",
          ephemeral: true,
        });
        return true;
      }
      const number = ctx.services.moderation.nextNumber(guildId);
      await ctx.services.moderation.add({
        number,
        guildId,
        type: "warn",
        targetId: user.id,
        targetTag: user.tag,
        moderatorId: interaction.user.id,
        moderatorTag: interaction.user.tag,
        reason,
        durationMs: null,
        createdAt: new Date().toISOString(),
        active: true,
      });
      await member
        .send(`Vous avez reçu un avertissement sur **${interaction.guild?.name}** : ${reason}`)
        .catch(() => null);
      await interaction.reply({ content: `Avertissement enregistré — cas #${number}.` });
      return true;
    }

    case "cases": {
      const user = interaction.options.getUser("membre", true);
      const cases = ctx.services.moderation.forTarget(guildId, user.id);
      if (cases.length === 0) {
        await interaction.reply({ content: `Aucun cas pour ${user.tag}.`, ephemeral: true });
        return true;
      }
      const lines = cases
        .slice(-15)
        .map(
          (c) =>
            `**#${c.number}** ${c.type} — ${truncate(c.reason, 120)} (<t:${Math.floor(new Date(c.createdAt).getTime() / 1000)}:d>)`,
        );
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`Cas de ${user.tag}`)
            .setDescription(lines.join("\n"))
            .setFooter({ text: `${cases.length} cas au total` }),
        ],
        ephemeral: true,
      });
      return true;
    }

    case "giveaway": {
      if (!cfg.giveaways.enabled) {
        await interaction.reply({
          content: "Les concours ne sont pas activés. Activez-les dans le tableau de bord.",
          ephemeral: true,
        });
        return true;
      }
      await interaction.deferReply();
      const prize = interaction.options.getString("lot", true);
      const durationRaw =
        interaction.options.getString("duree") ?? `${cfg.giveaways.defaultDurationMinutes}m`;
      const durationMs = parseDuration(durationRaw);
      if (durationMs === null) {
        await interaction.editReply({
          content: `Durée invalide : « ${durationRaw} ». Utilisez par exemple 30m, 2h ou 1d.`,
        });
        return true;
      }
      const winners = Math.min(
        interaction.options.getInteger("gagnants") ?? 1,
        cfg.giveaways.maxWinners,
      );
      const endsAt = Date.now() + durationMs;

      const message = await interaction.editReply({
        content: "",
        embeds: [
          new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle(`🎉 ${prize}`)
            .setDescription(
              `Cliquez sur **Participer** pour tenter votre chance.\nFin : <t:${Math.floor(endsAt / 1000)}:R>`,
            )
            .setFooter({ text: `${winners} gagnant(s)` }),
        ],
        components: [
          {
            type: 1,
            components: [{ type: 2, style: 1, label: "Participer", customId: "giveaway:enter" }],
          },
        ],
      });

      await ctx.services.giveaways.add({
        guildId,
        channelId: interaction.channelId,
        messageId: message.id,
        hostId: interaction.user.id,
        prize,
        winnerCount: winners,
        entrants: [],
        winnerIds: [],
        endsAt,
        ended: false,
        requiredRoleId: cfg.giveaways.requiredRoleId,
        minAccountAgeDays: cfg.giveaways.minAccountAgeDays,
        createdAt: new Date().toISOString(),
      });
      return true;
    }

    case "ticket-panel": {
      if (!cfg.tickets.enabled) {
        await interaction.reply({
          content: "Les tickets ne sont pas activés. Activez-les dans le tableau de bord.",
          ephemeral: true,
        });
        return true;
      }
      await interaction.deferReply({ ephemeral: true });
      const channel = interaction.channel;
      if (!channel?.isTextBased() || !("send" in channel)) {
        await interaction.editReply({ content: "Ce salon ne peut pas recevoir le panneau." });
        return true;
      }
      const panel = await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("Support")
            .setDescription(
              "Cliquez sur le bouton ci-dessous pour ouvrir un ticket privé avec l'équipe.",
            ),
        ],
        components: [
          {
            type: 1,
            components: [{ type: 2, style: 1, label: "Ouvrir un ticket", customId: "ticket:open" }],
          },
        ],
      });
      await ctx.services.guildConfig.patch(guildId, {
        tickets: { panelChannelId: channel.id, panelMessageId: panel.id },
      });
      await interaction.editReply({ content: `Panneau publié dans ${channel}.` });
      return true;
    }

    case "config": {
      const sub = interaction.options.getSubcommand(true);
      if (sub === "show") {
        const shown = JSON.stringify(ctx.services.guildConfig.get(guildId), null, 2);
        // The config is longer than an embed field allows, so it goes as a file.
        await interaction.reply({
          files: [{ attachment: Buffer.from(shown, "utf8"), name: `config-${guildId}.json` }],
          ephemeral: true,
        });
        return true;
      }
      if (sub === "set") {
        const feature = interaction.options.getString("fonction", true) as
          | "welcome"
          | "autorole"
          | "levels"
          | "logging"
          | "tickets"
          | "giveaways"
          | "starboard"
          | "tempVoice"
          | "autoresponder";
        const active = interaction.options.getBoolean("actif", true);
        await ctx.services.guildConfig.patch(guildId, { [feature]: { enabled: active } } as never);
        await interaction.reply({
          content: `${feature} : ${active ? "activé" : "désactivé"}.`,
          ephemeral: true,
        });
        return true;
      }
      if (sub === "channel") {
        const feature = interaction.options.getString("fonction", true);
        const channel = interaction.options.getChannel("salon");
        const channelId = channel?.id ?? null;
        const patches: Record<string, unknown> = {
          welcome: { welcome: { channelId } },
          logging: { logging: { channelId } },
          starboard: { starboard: { channelId } },
          levelsAnnounce: { levels: { announceChannelId: channelId } },
          ticketsPanel: { tickets: { panelChannelId: channelId } },
          ticketsTranscript: { tickets: { transcriptChannelId: channelId } },
        };
        await ctx.services.guildConfig.patch(guildId, patches[feature] as never);
        await interaction.reply({
          content: channelId ? `Salon défini : <#${channelId}>.` : "Salon retiré.",
          ephemeral: true,
        });
        return true;
      }
      return true;
    }

    case "permissions": {
      const me = interaction.guild?.members.me;
      if (!me) {
        await interaction.reply({
          content: "Impossible de lire mes permissions.",
          ephemeral: true,
        });
        return true;
      }
      const required: [bigint, string][] = [
        [PermissionFlagsBits.ViewChannel, "Voir les salons"],
        [PermissionFlagsBits.SendMessages, "Envoyer des messages"],
        [PermissionFlagsBits.EmbedLinks, "Intégrer des liens"],
        [PermissionFlagsBits.ReadMessageHistory, "Lire l'historique"],
        [PermissionFlagsBits.ManageRoles, "Gérer les rôles"],
        [PermissionFlagsBits.ManageChannels, "Gérer les salons"],
        [PermissionFlagsBits.KickMembers, "Expulser des membres"],
        [PermissionFlagsBits.BanMembers, "Bannir des membres"],
        [PermissionFlagsBits.ModerateMembers, "Exclure temporairement"],
        [PermissionFlagsBits.ManageMessages, "Gérer les messages"],
        [PermissionFlagsBits.ViewAuditLog, "Voir les journaux d'audit"],
        [PermissionFlagsBits.ManageEvents, "Gérer les événements"],
      ];
      const lines = required.map(
        ([bit, label]) => `${me.permissions.has(bit) ? "✅" : "❌"} ${label}`,
      );
      const missing = required.filter(([bit]) => !me.permissions.has(bit)).length;
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(missing === 0 ? 0x57f287 : 0xfee75c)
            .setTitle("Permissions du bot")
            .setDescription(lines.join("\n"))
            .setFooter({
              text:
                missing === 0
                  ? "Toutes les permissions nécessaires sont accordées."
                  : `${missing} permission(s) manquante(s) — certaines fonctions seront silencieusement inactives.`,
            }),
        ],
        ephemeral: true,
      });
      return true;
    }

    default:
      return false;
  }
}

export { commands as commandDefinitions };
