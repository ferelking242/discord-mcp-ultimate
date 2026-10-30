# Audit du bot — ce qui existe, ce qui manquait

Audit fait sur le code réel de `src/bot/`, pas sur la documentation. Chaque ligne
« existe » renvoie à un fichier qu'on peut ouvrir.

## Ce qui existait déjà

| Domaine                                                        | État           | Où                                              |
| -------------------------------------------------------------- | -------------- | ----------------------------------------------- |
| Connexion Discord, un seul gateway                             | ✅             | `src/bot/index.ts`                              |
| Rôles par réaction (menus, toggle/add-only, fichier surveillé) | ✅             | `src/bot/reactionRoles.ts`, `handlers.ts`       |
| Bienvenue / au revoir, DM de bienvenue                         | ✅             | `eventHandlers.ts`                              |
| Rôles automatiques avec seuil d'ancienneté du compte           | ✅             | `features.ts` (`shouldGrantAutoroles`)          |
| Niveaux (XP, cooldown, récompenses de rôle)                    | ✅             | `stores.ts` (`LevelStore`), `features.ts`       |
| Journaux d'événements                                          | ✅             | `eventHandlers.ts`, `logging.ts`                |
| Cas de modération numérotés (`/warn`, `/cases`)                | ⚠️ partiel     | `stores.ts` (`ModerationStore`), `commands.ts`  |
| Tickets (panneau, ouverture, fermeture, transcript)            | ✅             | `stores.ts` (`TicketStore`), `eventHandlers.ts` |
| Concours (bouton, tirage, balayeur)                            | ✅             | `stores.ts` (`GiveawayStore`)                   |
| Starboard                                                      | ✅             | `stores.ts` (`StarboardStore`)                  |
| Vocal temporaire                                               | ✅             | `stores.ts` (`TempVoiceStore`)                  |
| Répondeur automatique                                          | ✅             | `features.ts` (`matchAutoresponder`)            |
| Commandes slash                                                | ⚠️ 9 seulement | `commands.ts`                                   |
| Configuration par serveur                                      | ⚠️ partielle   | `guildConfig.ts`                                |
| Serveur MCP HTTP (177 outils)                                  | ✅             | `src/tools/`, `src/bot/http.ts`                 |

## Ce qui manquait réellement

### 1. Modération — le trou le plus grave

`ModerationStore` gère déjà neuf types de cas (`ban`, `unban`, `kick`, `timeout`,
`untimeout`, `warn`, `note`, `softban`, `purge`), mais **seul `warn` était
branché**. Le store était donc en grande partie du code mort : impossible de
bannir, expulser ou exclure depuis le bot. Combler ce trou était la priorité.

### 2. Configuration — le dashboard supprimé laissait un vide

`/config` ne proposait que `show`, `set` et `channel`. Depuis la suppression du
tableau de bord, plus aucun moyen de régler un texte de bienvenue, un seuil de
starboard, un nombre de gagnants ou une liste de rôles. Le bot était configurable
à moitié, ce qui est pire que pas configurable du tout : on croit avoir réglé.

### 3. Utilitaires absents

Aucun `/serverinfo`, `/userinfo`, `/avatar`, `/slowmode`, `/poll`, `/remind`,
`/afk`, `/lock`. Un bot d'administration sans ces commandes oblige à repasser par
l'interface Discord à la main.

### 4. `DISCORD_ADMIN_ROLES` était un champ mort

`adminRoleIds` était lu depuis l'environnement, transmis au gestionnaire de
commandes… et jamais consulté. La variable donnait l'illusion de restreindre les
commandes d'administration. Elle est maintenant réellement vérifiée.

### 5. Bug : le message de `/ticket-panel` parlait du dashboard

> « Activez-les dans le tableau de bord. »

Le tableau de bord n'existe plus. Corrigé en « `/config set tickets true` ».

## Ce qui reste volontairement absent

- **Musique** — question de licence, pas de fonctionnalité.
- **Économie** — l'XP sert à débloquer des rôles ; une seconde monnaie serait un
  second store et un second lot d'exploits.
- **Anti-raid au-delà de l'âge du compte** — demande un modèle de score sur la
  vélocité des arrivées. AutoMod et les niveaux de vérification couvrent le
  cas courant.
- **Création d'un serveur Discord** — impossible pour un bot : l'API exige un
  jeton d'utilisateur. Voir la section « Limitations » du README.
