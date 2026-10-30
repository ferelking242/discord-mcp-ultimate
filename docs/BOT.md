# Le bot — serveur 24h/24

Ce dépôt contient **deux choses qui partagent une seule connexion Discord** :

| Composant           | Commande      | Rôle                                                            |
| ------------------- | ------------- | --------------------------------------------------------------- |
| Serveur MCP (stdio) | `npm start`   | Expose les 177 outils à une IA locale (Claude Desktop, Cursor…) |
| Bot 24h/24          | `npm run bot` | Réactions → rôles, DM de bienvenue, et MCP accessible en HTTP   |

Un seul processus suffit : `npm run bot` démarre le bot **et** le point d'accès MCP en HTTP. Le lancer deux fois avec le même jeton ouvre deux sessions gateway, ce qui double chaque événement — n'en lancez qu'un.

## Ce que fait le bot

- **Rôles par réaction.** Un membre ajoute ✅ sous un message, il obtient le rôle. Il retire sa réaction, le rôle part (`BOT_REACTION_MODE=toggle`) ou reste (`add-only`).
- **DM de bienvenue.** Désactivé par défaut. Les MP fermés sont traités comme un cas normal, pas comme une erreur.
- **MCP en HTTP.** Le même catalogue d'outils, joignable par un client qui ne peut pas lancer un processus local.

## Installation sur un serveur

```bash
git clone https://github.com/ferelking242/discord-mcp-ultimate.git
cd discord-mcp-ultimate
npm ci                 # installation reproductible
npm run build          # compile TypeScript -> dist/
cp .env.example .env   # puis renseignez DISCORD_TOKEN
```

Test rapide, sans rester en arrière-plan :

```bash
npm run bot:start
```

### systemd

`/etc/systemd/system/discord-mcp.service` :

```ini
[Unit]
Description=Discord MCP Ultimate (bot + MCP HTTP)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=discordmcp
WorkingDirectory=/opt/discord-mcp-ultimate
EnvironmentFile=/opt/discord-mcp-ultimate/.env
ExecStart=/usr/bin/node dist/bot/index.js
Restart=always
RestartSec=5
# Le jeton est dans EnvironmentFile : le durcissement ci-dessous n'y touche pas.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/discord-mcp-ultimate/.data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now discord-mcp
journalctl -u discord-mcp -f     # suit les logs
```

`ReadWritePaths` sur `.data/` est nécessaire : le magasin de rôles-réactions y écrit.

### Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
ENV NODE_ENV=production
CMD ["node", "dist/bot/index.js"]
```

```bash
docker build -t discord-mcp-ultimate .
docker run -d --name discord-mcp --restart unless-stopped \
  --env-file .env -p 127.0.0.1:3000:3000 \
  -v discord-mcp-data:/app/.data \
  discord-mcp-ultimate
```

`-p 127.0.0.1:3000:3000` n'expose le port que sur la machine. Retirez le `127.0.0.1:` seulement derrière un reverse proxy TLS.

## Endpoints HTTP

| Route     | Méthode | Auth   | Réponse                                                |
| --------- | ------- | ------ | ------------------------------------------------------ |
| `/health` | GET     | aucune | `{"status":"ok","uptimeSeconds":n}` — pour un moniteur |
| `/status` | GET     | Bearer | état Discord, sessions MCP ouvertes, nombre de menus   |
| `/mcp`    | POST    | Bearer | transport MCP Streamable HTTP                          |

`/health` est volontairement sans authentification : une sonde de supervision ne doit pas porter de secret, et la réponse ne contient rien de sensible.

Tout le reste exige `Authorization: Bearer <MCP_HTTP_TOKEN>`. La comparaison du jeton est à temps constant. Si `MCP_HTTP_ENABLED=true` et que le jeton manque, le processus refuse de démarrer : un port ouvert sans authentification serait un accès administrateur distant.

```bash
curl -s localhost:3000/health
curl -s -H "Authorization: Bearer $MCP_HTTP_TOKEN" localhost:3000/status
```

## Brancher une IA sur le MCP en HTTP

Un client qui accepte une URL de serveur MCP :

```
URL   : https://mcp.example.com/mcp
Header: Authorization: Bearer <MCP_HTTP_TOKEN>
```

Derrière un reverse proxy, transmettez l'en-tête `Authorization` tel quel et activez TLS. Le jeton circule en clair sur `http://` : ne l'utilisez ainsi qu'en local.

## Créer un menu de rôles par réaction

Le bot doit tourner. Ensuite, depuis n'importe quel client MCP connecté :

> Crée un menu de rôles dans #roles avec le titre « Choisis tes rôles », et associe ✅ au rôle Announcements, 🔥 à Gaming et 🎨 à Art.

L'outil `discord_create_reaction_role_menu` poste l'embed, ajoute les réactions et enregistre les associations. Le bot relit le fichier sous deux secondes : **aucun redémarrage**.

Les rôles situés au niveau du rôle le plus haut du bot, ou au-dessus, sont refusés **avant** que quoi que ce soit soit posté, avec la raison. Discord refuserait l'attribution de toute façon ; autant le dire tout de suite.

## Limites, mesurées

- **Un seul processus par jeton.** Deux clients gateway avec le même jeton se disputent la session.
- **Les intents privilégiés doivent être activés** dans le portail développeur (Server Members, Message Content). Sinon la connexion se ferme avec le code **4014** ; le bot journalise alors la marche à suivre.
- **Les rôles gérés** (par une intégration, un bot ou un booster) ne peuvent pas être attribués.
- **20 réactions maximum par message** — c'est une limite Discord, pas un choix.
- **Pas de « accepter les règles par réaction ».** Le bot voit bien les réactions, mais un serveur MCP lancé en stdio n'a pas d'écouteur permanent. Le bot 24h/24, lui, en a un : c'est pour cela que le mode bot existe. Pour un vrai verrou d'entrée, utilisez le filtrage d'adhésion Discord.
- **Redémarrage = compteurs de limitation remis à zéro.** C'est sans conséquence : ils ne protègent que contre l'emballement d'un membre sur quelques secondes.

## Dépannage

| Symptôme                                           | Cause probable                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `gateway closed with 4014`                         | Intent privilégié désactivé dans le portail, ou `DISCORD_GUILD_MEMBERS=false` |
| `MCP_HTTP_TOKEN is required`                       | `MCP_HTTP_ENABLED=true` sans jeton                                            |
| La réaction ne donne pas le rôle                   | Bot arrêté, ou rôle au-dessus du rôle le plus haut du bot                     |
| `role ... sits at or above the bot's highest role` | Déplacez le rôle du bot plus haut dans la hiérarchie                          |
| `Cannot send messages to this user`                | MP fermés — normal, ce n'est pas une erreur                                   |
| `/mcp` répond 401                                  | En-tête `Authorization: Bearer …` absent ou faux                              |
