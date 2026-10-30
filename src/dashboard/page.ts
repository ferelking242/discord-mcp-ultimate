import { DASHBOARD_CSS } from "./assets.js";

/**
 * The dashboard's single page.
 *
 * One document and one same-origin script, no framework and no CDN. The
 * `Content-Security-Policy` the API sends allows nothing else, which is why the
 * script is served from the bot's own origin rather than inlined: an inline script
 * would force `'unsafe-inline'` into the policy and give up most of its value.
 */
export function renderDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Discord MCP Ultimate — Dashboard</title>
<link rel="stylesheet" href="/dashboard.css">
</head>
<body>
<div id="root"></div>
<div id="toast" class="toast hidden"></div>
<script src="/dashboard.js" type="module"></script>
</body>
</html>`;
}

/** The stylesheet, served at `/dashboard.css`. */
export function renderDashboardCss(): string {
  return DASHBOARD_CSS;
}

/**
 * The client script.
 *
 * Written as one string so it is part of the TypeScript build and needs no
 * bundler. It talks to the JSON API only, keeps no state the server does not have,
 * and re-reads the CSRF token from `/api/session` on load so a page left open
 * across a restart recovers instead of failing every save.
 */
export function renderDashboardScript(): string {
  return `const $ = (sel, root = document) => root.querySelector(sel);
const root = $("#root");

const state = {
  csrf: null,
  guilds: [],
  guildId: null,
  config: null,
  guild: null,
  view: "overview",
  busy: false,
};

// ── Transport ────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const init = { credentials: "same-origin", headers: {}, ...options };
  if (init.body && typeof init.body !== "string") {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(init.body);
  }
  if (init.method && init.method !== "GET" && state.csrf) {
    init.headers["x-csrf-token"] = state.csrf;
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
  return data;
}

let toastTimer;
function toast(message, kind) {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast " + (kind || "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4200);
}

function esc(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtDuration(seconds) {
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
  return Math.floor(seconds / 86400) + "d";
}

// ── Login ────────────────────────────────────────────────────────────────────

function renderLogin(errorText) {
  root.innerHTML =
    '<div class="login-wrap"><form class="login-card" id="login-form">' +
      '<div class="login-mark">🛡️</div>' +
      "<h1>Discord MCP Ultimate</h1>" +
      "<p>Panneau d'administration du bot.</p>" +
      '<div class="field"><label for="pw">Mot de passe</label>' +
        '<input id="pw" type="password" autocomplete="current-password" autofocus></div>' +
      '<button class="btn" type="submit" style="width:100%">Se connecter</button>' +
      (errorText ? '<div class="err-text">' + esc(errorText) + "</div>" : "") +
    "</form></div>";

  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#login-form button");
    button.disabled = true;
    button.innerHTML = '<span class="spin"></span> Connexion…';
    try {
      const data = await api("/api/login", { method: "POST", body: { password: $("#pw").value } });
      state.csrf = data.csrf;
      await boot();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

// ── Shell ────────────────────────────────────────────────────────────────────

const NAV = [
  { id: "overview", label: "Vue d'ensemble", icon: "📊" },
  { id: "welcome", label: "Bienvenue", icon: "👋" },
  { id: "autorole", label: "Rôles automatiques", icon: "🎭" },
  { id: "levels", label: "Niveaux", icon: "📈" },
  { id: "logging", label: "Journaux", icon: "📝" },
  { id: "moderation", label: "Modération", icon: "🔨" },
  { id: "tickets", label: "Tickets", icon: "🎫" },
  { id: "giveaways", label: "Concours", icon: "🎉" },
  { id: "starboard", label: "Starboard", icon: "⭐" },
  { id: "tempvoice", label: "Vocal temporaire", icon: "🔊" },
  { id: "autoresponder", label: "Répondeur", icon: "💬" },
];

function renderShell() {
  const guildOptions = state.guilds
    .map((g) => '<option value="' + esc(g.id) + '"' + (g.id === state.guildId ? " selected" : "") + ">" + esc(g.name) + "</option>")
    .join("");

  root.innerHTML =
    '<div class="shell">' +
      '<aside class="side">' +
        '<div class="brand"><div class="brand-dot">🛡️</div>' +
          "<div><strong>MCP Ultimate</strong><small>Bot &amp; MCP</small></div></div>" +
        '<nav class="nav" id="nav">' +
          NAV.map((item) =>
            '<button data-view="' + item.id + '"' + (state.view === item.id ? ' class="on"' : "") + ">" +
              '<span class="ic">' + item.icon + "</span>" + item.label + "</button>",
          ).join("") +
          '<div class="sep"></div>' +
          '<button data-action="logout"><span class="ic">🚪</span>Déconnexion</button>' +
        "</nav>" +
      "</aside>" +
      '<main class="main">' +
        '<div class="top">' +
          '<div><h1 id="title"></h1><div class="who" id="subtitle"></div></div>' +
          '<select class="guild-pick" id="guild-pick">' + (guildOptions || '<option>Aucun serveur</option>') + "</select>" +
        "</div>" +
        '<div id="view"></div>' +
      "</main>" +
    "</div>";

  $("#nav").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.action === "logout") return logout();
    state.view = button.dataset.view;
    document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b === button));
    renderView();
  });

  $("#guild-pick").addEventListener("change", async (event) => {
    state.guildId = event.target.value;
    await loadGuild();
    renderView();
  });
}

async function logout() {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  state.csrf = null;
  renderLogin();
}

// ── Views ────────────────────────────────────────────────────────────────────

function viewContainer() { return $("#view"); }

function header(title, subtitle) {
  $("#title").textContent = title;
  $("#subtitle").textContent = subtitle;
}

async function renderView() {
  const container = viewContainer();
  container.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  try {
    if (state.view === "overview") return await viewOverview(container);
    if (!state.guildId) {
      container.innerHTML = '<div class="empty">Invitez le bot sur un serveur pour commencer.</div>';
      return;
    }
    const renderers = {
      welcome: viewWelcome,
      autorole: viewAutorole,
      levels: viewLevels,
      logging: viewLogging,
      moderation: viewModeration,
      tickets: viewTickets,
      giveaways: viewGiveaways,
      starboard: viewStarboard,
      tempvoice: viewTempVoice,
      autoresponder: viewAutoresponder,
    };
    await renderers[state.view](container);
  } catch (err) {
    container.innerHTML = '<div class="empty">Erreur : ' + esc(err.message) + "</div>";
  }
}

async function viewOverview(container) {
  const data = await api("/api/overview");
  state.guilds = data.guilds;
  if (!state.guildId && data.guilds.length) state.guildId = data.guilds[0].id;
  header("Vue d'ensemble", data.bot.tag + " · " + fmtDuration(data.bot.uptimeSeconds) + " en ligne · " + data.bot.ping + " ms");

  const stats = [
    ["Serveurs", data.guilds.length],
    ["Membres suivis", data.stats.trackedMembers],
    ["Tickets ouverts", data.stats.openTickets],
    ["Concours actifs", data.stats.activeGiveaways],
    ["Menus de rôles", data.stats.reactionRoleMenus],
    ["Cas de modération", data.stats.moderationCases],
    ["Starboard", data.stats.starboardEntries],
    ["Vocaux temporaires", data.stats.tempChannels],
  ];

  container.innerHTML =
    '<div class="grid">' +
      stats.map((s) => '<div class="card"><h3>' + esc(s[0]) + '</h3><div class="stat">' + esc(s[1]) + "</div></div>").join("") +
    "</div>" +
    '<div class="card wide" style="margin-top:14px">' +
      "<h3>Serveurs</h3>" +
      '<div class="scroll"><table><thead><tr><th>Nom</th><th>ID</th><th>Membres</th><th>Bot</th></tr></thead><tbody>' +
      data.guilds.map((g) =>
        "<tr><td>" + esc(g.name) + '</td><td class="mono">' + esc(g.id) + "</td><td>" + esc(g.memberCount) + "</td><td>" +
        '<span class="pill ' + (g.botPresent ? "ok" : "danger") + '">' + (g.botPresent ? "présent" : "absent") + "</span></td></tr>",
      ).join("") +
      "</tbody></table></div></div>" +
    '<div class="card wide" style="margin-top:14px">' +
      "<h3>MCP</h3><p class=\\"muted\\">Transport HTTP " + (data.mcpEnabled ? "activé" : "désactivé") +
      " sur <code class=\\"mono\\">/mcp</code>. " +
      (data.mcpEnabled ? "Authentification par jeton Bearer requise." : "Activez MCP_HTTP_ENABLED pour l'exposer.") +
      "</p></div>";

  renderShell();
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
}

function checkbox(id, label, checked, hint) {
  return '<label class="check"><input type="checkbox" id="' + id + '"' + (checked ? " checked" : "") + ">" +
    "<span>" + esc(label) + (hint ? ' <span class="hint">' + esc(hint) + "</span>" : "") + "</span></label>";
}

function textField(id, label, value, hint) {
  return '<div class="field"><label for="' + id + '">' + esc(label) + "</label>" +
    '<input id="' + id + '" type="text" value="' + esc(value) + '">' +
    (hint ? '<div class="hint">' + esc(hint) + "</div>" : "") + "</div>";
}

function numberField(id, label, value, hint) {
  return '<div class="field"><label for="' + id + '">' + esc(label) + "</label>" +
    '<input id="' + id + '" type="number" value="' + esc(value) + '">' +
    (hint ? '<div class="hint">' + esc(hint) + "</div>" : "") + "</div>";
}

function channelSelect(id, label, value, channels, hint) {
  const options = ['<option value="">— aucun —</option>']
    .concat(channels.map((c) => '<option value="' + esc(c.id) + '"' + (c.id === value ? " selected" : "") + ">#" + esc(c.name) + "</option>"))
    .join("");
  return '<div class="field"><label for="' + id + '">' + esc(label) + "</label>" +
    '<select id="' + id + '">' + options + "</select>" +
    (hint ? '<div class="hint">' + esc(hint) + "</div>" : "") + "</div>";
}

/** Channels the bot can post in, so the pickers never offer a channel it cannot use. */
function postableChannels() {
  if (!state.guild) return [];
  return state.guild.channels.filter((c) => c.type === "text" || c.type === "announcement");
}

function rolesBelowBot() {
  if (!state.guild) return [];
  return state.guild.roles.filter((r) => !r.managed && r.position < state.guild.botHighestRolePosition);
}

function saveBar() {
  return '<div class="actions"><button class="btn" id="save">Enregistrer</button>' +
    '<button class="btn ghost" id="reload">Recharger</button>' +
    '<span class="muted" id="save-state"></span></div>';
}

async function saveConfig(patch) {
  const data = await api("/api/guilds/" + state.guildId + "/config", { method: "PATCH", body: patch });
  state.config = data.config;
  toast("Enregistré.", "ok");
}

function wireSave(build) {
  $("#save").addEventListener("click", async () => {
    const button = $("#save");
    button.disabled = true;
    $("#save-state").innerHTML = '<span class="spin"></span>';
    try {
      await saveConfig(build());
      $("#save-state").textContent = "";
    } catch (err) {
      toast(err.message, "err");
      $("#save-state").textContent = "";
    } finally {
      button.disabled = false;
    }
  });
  $("#reload").addEventListener("click", async () => {
    await loadGuild();
    renderView();
  });
}

async function viewWelcome(container) {
  const c = state.config.welcome;
  header("Bienvenue", "Messages d'arrivée et de départ");
  container.innerHTML =
    '<div class="card">' +
      checkbox("enabled", "Activer le message d'arrivée", c.enabled) +
      channelSelect("channelId", "Salon d'arrivée", c.channelId, postableChannels()) +
      '<div class="field"><label for="message">Message</label><textarea id="message">' + esc(c.message) + "</textarea>" +
        '<div class="hint">Variables : {user} {username} {server} {memberCount}</div></div>' +
      checkbox("dmEnabled", "Envoyer aussi un message privé", c.dmEnabled) +
      '<div class="field"><label for="dmMessage">Message privé</label><textarea id="dmMessage">' + esc(c.dmMessage) + "</textarea></div>" +
      checkbox("goodbyeEnabled", "Activer le message de départ", c.goodbyeEnabled) +
      '<div class="field"><label for="goodbyeMessage">Message de départ</label><textarea id="goodbyeMessage">' + esc(c.goodbyeMessage) + "</textarea></div>" +
      saveBar() +
    "</div>";
  wireSave(() => ({
    welcome: {
      enabled: $("#enabled").checked,
      channelId: $("#channelId").value || null,
      message: $("#message").value,
      dmEnabled: $("#dmEnabled").checked,
      dmMessage: $("#dmMessage").value,
      goodbyeEnabled: $("#goodbyeEnabled").checked,
      goodbyeMessage: $("#goodbyeMessage").value,
    },
  }));
}

async function viewAutorole(container) {
  const c = state.config.autorole;
  const roles = rolesBelowBot();
  header("Rôles automatiques", "Attribués à l'arrivée");
  container.innerHTML =
    '<div class="card">' +
      checkbox("enabled", "Activer les rôles automatiques", c.enabled) +
      '<div class="field"><label>Rôles attribués</label><div class="scroll" style="max-height:230px;border:1px solid var(--border);border-radius:8px;padding:8px">' +
        (roles.length
          ? roles.map((r) =>
              '<label class="check"><input type="checkbox" class="role-box" value="' + esc(r.id) + '"' +
              (c.roleIds.includes(r.id) ? " checked" : "") + "><span>" + esc(r.name) + "</span></label>",
            ).join("")
          : '<div class="empty">Aucun rôle que le bot peut attribuer. Déplacez son rôle plus haut.</div>') +
      "</div><div class=\\"hint\\">Les rôles gérés par une intégration et ceux au-dessus du rôle du bot ne sont pas proposés.</div></div>" +
      numberField("minAccountAgeDays", "Âge minimum du compte (jours)", c.minAccountAgeDays, "0 = aucune restriction. Un compte neuf est le moyen le plus simple de raid.") +
      saveBar() +
    "</div>";
  wireSave(() => ({
    autorole: {
      enabled: $("#enabled").checked,
      roleIds: [...document.querySelectorAll(".role-box:checked")].map((el) => el.value),
      minAccountAgeDays: Number($("#minAccountAgeDays").value),
    },
  }));
}

async function viewLevels(container) {
  const c = state.config.levels;
  header("Niveaux", "XP, récompenses et classement");
  const board = await api("/api/guilds/" + state.guildId + "/leaderboard?limit=10").catch(() => ({ leaderboard: [] }));
  const roles = rolesBelowBot();
  container.innerHTML =
    '<div class="card">' +
      checkbox("enabled", "Activer les niveaux", c.enabled) +
      '<div class="row">' +
        numberField("xpMin", "XP minimum par message", c.xpMin) +
        numberField("xpMax", "XP maximum par message", c.xpMax) +
      "</div>" +
      numberField("cooldownSeconds", "Délai entre deux gains (secondes)", c.cooldownSeconds) +
      checkbox("announce", "Annoncer les passages de niveau", c.announce) +
      channelSelect("announceChannelId", "Salon d'annonce", c.announceChannelId, postableChannels()) +
      textField("levelUpMessage", "Message de passage", c.levelUpMessage, "Variables : {user} {level}") +
      '<div class="field"><label>Récompenses de rôle</label><div id="rewards">' +
        c.roleRewards.map((r) => rewardRow(r.level, r.roleId, roles)).join("") +
      '</div><button class="btn ghost" id="add-reward" type="button">+ Ajouter une récompense</button></div>' +
      saveBar() +
    "</div>" +
    '<div class="card wide" style="margin-top:14px"><h3>Classement</h3>' +
      (board.leaderboard.length
        ? '<table><thead><tr><th>#</th><th>Membre</th><th>Niveau</th><th>XP</th></tr></thead><tbody>' +
          board.leaderboard.map((r, i) =>
            "<tr><td>" + (i + 1) + '</td><td class="mono">' + esc(r.userId) + "</td><td>" + esc(r.level) + "</td><td>" + esc(r.xp) + "</td></tr>",
          ).join("") + "</tbody></table>"
        : '<div class="empty">Aucun membre suivi pour le moment.</div>') +
    "</div>";

  const rewards = $("#rewards");
  $("#add-reward").addEventListener("click", () => {
    rewards.insertAdjacentHTML("beforeend", rewardRow(1, "", roles));
  });
  rewards.addEventListener("click", (event) => {
    if (event.target.classList.contains("rm")) event.target.closest(".reward-row").remove();
  });

  wireSave(() => ({
    levels: {
      enabled: $("#enabled").checked,
      xpMin: Number($("#xpMin").value),
      xpMax: Number($("#xpMax").value),
      cooldownSeconds: Number($("#cooldownSeconds").value),
      announce: $("#announce").checked,
      announceChannelId: $("#announceChannelId").value || null,
      levelUpMessage: $("#levelUpMessage").value,
      roleRewards: [...document.querySelectorAll(".reward-row")].map((row) => ({
        level: Number(row.querySelector(".reward-level").value),
        roleId: row.querySelector(".reward-role").value,
      })).filter((r) => r.roleId),
    },
  }));
}

function rewardRow(level, roleId, roles) {
  return '<div class="reward-row" style="display:flex;gap:8px;margin-bottom:8px">' +
    '<input class="reward-level" type="number" value="' + esc(level) + '" style="width:90px" title="Niveau">' +
    '<select class="reward-role" style="flex:1"><option value="">— rôle —</option>' +
    roles.map((r) => '<option value="' + esc(r.id) + '"' + (r.id === roleId ? " selected" : "") + ">" + esc(r.name) + "</option>").join("") +
    '</select><button class="btn ghost rm" type="button">✕</button></div>';
}

const LOG_EVENTS = ["messageDelete","messageEdit","memberJoin","memberLeave","memberBan","memberUnban","memberUpdate","roleCreate","roleDelete","roleUpdate","channelCreate","channelDelete","channelUpdate","voiceJoin","voiceLeave","inviteCreate","inviteDelete"];

async function viewLogging(container) {
  const c = state.config.logging;
  header("Journaux", "Événements du serveur");
  container.innerHTML =
    '<div class="card">' +
      checkbox("enabled", "Activer les journaux", c.enabled) +
      channelSelect("channelId", "Salon des journaux", c.channelId, postableChannels(), "Le bot a besoin de Voir les journaux d'audit pour nommer l'auteur d'une action.") +
      '<div class="field"><label>Événements suivis</label>' +
        LOG_EVENTS.map((e) =>
          '<label class="check"><input type="checkbox" class="ev" value="' + e + '"' +
          (c.events.includes(e) ? " checked" : "") + "><span>" + e + "</span></label>",
        ).join("") +
      "</div>" +
      saveBar() +
    "</div>";
  wireSave(() => ({
    logging: {
      enabled: $("#enabled").checked,
      channelId: $("#channelId").value || null,
      events: [...document.querySelectorAll(".ev:checked")].map((el) => el.value),
    },
  }));
}

const ACTIONS = [
  ["warn", "Avertir"], ["note", "Note"], ["timeout", "Exclure"],
  ["untimeout", "Lever l'exclusion"], ["kick", "Expulser"], ["ban", "Bannir"], ["unban", "Débannir"],
];

async function viewModeration(container) {
  const cases = await api("/api/cases?guildId=" + state.guildId).catch(() => ({ cases: [] }));
  const members = await api("/api/guilds/" + state.guildId + "/members?limit=100").catch(() => ({ members: [] }));
  header("Modération", "Actions et historique");
  container.innerHTML =
    '<div class="card">' +
      "<h3>Nouvelle action</h3>" +
      '<div class="field"><label for="target">Membre</label><select id="target">' +
        members.members.filter((m) => !m.isBot).map((m) => '<option value="' + esc(m.id) + '">' + esc(m.tag) + "</option>").join("") +
      "</select></div>" +
      '<div class="row">' +
        '<div class="field"><label for="action">Action</label><select id="action">' +
          ACTIONS.map((a) => '<option value="' + a[0] + '">' + a[1] + "</option>").join("") +
        "</select></div>" +
        numberField("minutes", "Durée (minutes, exclusion)", 10) +
      "</div>" +
      textField("reason", "Raison", "", "Enregistrée dans le cas et envoyée au membre si possible.") +
      '<div class="actions"><button class="btn danger" id="apply">Appliquer</button>' +
        '<span class="muted" id="apply-state"></span></div>' +
      '<div class="hint">Le bot doit avoir un rôle plus haut que celui du membre visé. Les actions sont irréversibles : Discord n’a pas d’annulation.</div>' +
    "</div>" +
    '<div class="card wide" style="margin-top:14px"><h3>Historique</h3>' +
      (cases.cases.length
        ? '<div class="scroll"><table><thead><tr><th>#</th><th>Type</th><th>Cible</th><th>Modérateur</th><th>Raison</th><th>Date</th></tr></thead><tbody>' +
          cases.cases.map((c) =>
            "<tr><td>" + esc(c.number) + '</td><td><span class="pill accent">' + esc(c.type) + "</span></td><td>" +
            esc(c.targetTag) + "</td><td>" + esc(c.moderatorTag) + "</td><td>" + esc(c.reason) + '</td><td class="mono">' +
            esc(new Date(c.createdAt).toLocaleString()) + "</td></tr>",
          ).join("") + "</tbody></table></div>"
        : '<div class="empty">Aucun cas enregistré.</div>') +
    "</div>";

  $("#apply").addEventListener("click", async () => {
    const button = $("#apply");
    button.disabled = true;
    $("#apply-state").innerHTML = '<span class="spin"></span>';
    try {
      const action = $("#action").value;
      const body = {
        action,
        userId: $("#target").value,
        reason: $("#reason").value || "no reason given",
      };
      if (action === "timeout") body.durationMs = Number($("#minutes").value) * 60000;
      const result = await api("/api/guilds/" + state.guildId + "/moderation", { method: "POST", body });
      toast("Cas #" + result.caseNumber + " — " + result.summary, "ok");
      renderView();
    } catch (err) {
      toast(err.message, "err");
      $("#apply-state").textContent = "";
    } finally {
      button.disabled = false;
    }
  });
}

async function viewTickets(container) {
  const c = state.config.tickets;
  const data = await api("/api/guilds/" + state.guildId + "/tickets").catch(() => ({ tickets: [] }));
  const roles = rolesBelowBot();
  header("Tickets", "Support par salon privé");
  container.innerHTML =
    '<div class="card">' +
      checkbox("enabled", "Activer les tickets", c.enabled) +
      channelSelect("panelChannelId", "Salon du panneau", c.panelChannelId, postableChannels()) +
      channelSelect("transcriptChannelId", "Salon des transcriptions", c.transcriptChannelId, postableChannels()) +
      '<div class="field"><label for="categoryId">Catégorie des tickets</label><select id="categoryId"><option value="">— aucune —</option>' +
        state.guild.channels.filter((ch) => ch.type === "category").map((ch) => '<option value="' + esc(ch.id) + '"' + (ch.id === c.categoryId ? " selected" : "") + ">" + esc(ch.name) + "</option>").join("") +
      "</select></div>" +
      '<div class="field"><label>Rôles support</label>' +
        roles.map((r) => '<label class="check"><input type="checkbox" class="sup" value="' + esc(r.id) + '"' + (c.supportRoleIds.includes(r.id) ? " checked" : "") + "><span>" + esc(r.name) + "</span></label>").join("") +
      "</div>" +
      checkbox("onePerMember", "Un seul ticket ouvert par membre", c.onePerMember) +
      textField("openMessage", "Message d'ouverture", c.openMessage) +
      saveBar() +
    "</div>" +
    '<div class="card wide" style="margin-top:14px"><h3>Tickets</h3>' +
      (data.tickets.length
        ? '<div class="scroll"><table><thead><tr><th>#</th><th>Membre</th><th>Statut</th><th>Salon</th><th>Créé</th></tr></thead><tbody>' +
          data.tickets.map((t) =>
            "<tr><td>" + esc(t.number) + "</td><td>" + esc(t.userTag) + '</td><td><span class="pill ' +
            (t.status === "open" ? "ok" : "") + '">' + esc(t.status) + "</span></td><td class=\\"mono\\">" + esc(t.channelId) +
            '</td><td class="mono">' + esc(new Date(t.createdAt).toLocaleString()) + "</td></tr>",
          ).join("") + "</tbody></table></div>"
        : '<div class="empty">Aucun ticket.</div>') +
    "</div>";
  wireSave(() => ({
    tickets: {
      enabled: $("#enabled").checked,
      panelChannelId: $("#panelChannelId").value || null,
      transcriptChannelId: $("#transcriptChannelId").value || null,
      categoryId: $("#categoryId").value || null,
      supportRoleIds: [...document.querySelectorAll(".sup:checked")].map((el) => el.value),
      onePerMember: $("#onePerMember").checked,
      openMessage: $("#openMessage").value,
    },
  }));
}

async function viewGiveaways(container) {
  const c = state.config.giveaways;
  const data = await api("/api/guilds/" + state.guildId + "/giveaways").catch(() => ({ giveaways: [] }));
  const roles = rolesBelowBot();
  header("Concours", "Tirages au sort");
  container.innerHTML =
    '<div class="card">' +
      checkbox("enabled", "Activer les concours", c.enabled) +
      '<div class="field"><label for="requiredRoleId">Rôle requis</label><select id="requiredRoleId"><option value="">— aucun —</option>' +
        roles.map((r) => '<option value="' + esc(r.id) + '"' + (r.id === c.requiredRoleId ? " selected" : "") + ">" + esc(r.name) + "</option>").join("") +
      "</select></div>" +
      numberField("minAccountAgeDays", "Âge minimum du compte (jours)", c.minAccountAgeDays) +
      numberField("defaultDurationMinutes", "Durée par défaut (minutes)", c.defaultDurationMinutes) +
      numberField("maxWinners", "Gagnants maximum", c.maxWinners) +
      saveBar() +
    "</div>" +
    '<div class="card wide" style="margin-top:14px"><h3>Concours</h3>' +
      (data.giveaways.length
        ? '<div class="scroll"><table><thead><tr><th>Lot</th><th>Participants</th><th>Fin</th><th>État</th></tr></thead><tbody>' +
          data.giveaways.map((g) =>
            "<tr><td>" + esc(g.prize) + "</td><td>" + esc(g.entrants.length) + '</td><td class="mono">' +
            esc(new Date(g.endsAt).toLocaleString()) + '</td><td><span class="pill ' + (g.ended ? "" : "ok") + '">' +
            (g.ended ? "terminé" : "en cours") + "</span></td></tr>",
          ).join("") + "</tbody></table></div>"
        : '<div class="empty">Aucun concours.</div>') +
    "</div>";
  wireSave(() => ({
    giveaways: {
      enabled: $("#enabled").checked,
      requiredRoleId: $("#requiredRoleId").value || null,
      minAccountAgeDays: Number($("#minAccountAgeDays").value),
      defaultDurationMinutes: Number($("#defaultDurationMinutes").value),
      maxWinners: Number($("#maxWinners").value),
    },
  }));
}

async function viewStarboard(container) {
  const c = state.config.starboard;
  header("Starboard", "Messages mis en avant");
  container.innerHTML =
    '<div class="card">' +
      checkbox("enabled", "Activer le starboard", c.enabled) +
      channelSelect("channelId", "Salon du starboard", c.channelId, postableChannels()) +
      textField("emoji", "Emoji", c.emoji) +
      numberField("threshold", "Seuil de réactions", c.threshold) +
      saveBar() +
    "</div>";
  wireSave(() => ({
    starboard: {
      enabled: $("#enabled").checked,
      channelId: $("#channelId").value || null,
      emoji: $("#emoji").value,
      threshold: Number($("#threshold").value),
    },
  }));
}

async function viewTempVoice(container) {
  const c = state.config.tempVoice;
  const voice = state.guild.channels.filter((ch) => ch.type === "voice");
  header("Vocal temporaire", "Salons vocaux à la demande");
  container.innerHTML =
    '<div class="card">' +
      checkbox("enabled", "Activer les vocaux temporaires", c.enabled) +
      '<div class="field"><label>Salons déclencheurs</label>' +
        (voice.length
          ? voice.map((ch) => '<label class="check"><input type="checkbox" class="hub" value="' + esc(ch.id) + '"' + (c.hubChannelIds.includes(ch.id) ? " checked" : "") + "><span>" + esc(ch.name) + "</span></label>").join("")
          : '<div class="empty">Aucun salon vocal.</div>') +
      "</div>" +
      '<div class="field"><label for="categoryId">Catégorie</label><select id="categoryId"><option value="">— aucune —</option>' +
        state.guild.channels.filter((ch) => ch.type === "category").map((ch) => '<option value="' + esc(ch.id) + '"' + (ch.id === c.categoryId ? " selected" : "") + ">" + esc(ch.name) + "</option>").join("") +
      "</select></div>" +
      textField("nameTemplate", "Nom du salon", c.nameTemplate, "Variable : {username}") +
      numberField("userLimit", "Limite de places (0 = illimité)", c.userLimit) +
      numberField("emptyTimeoutSeconds", "Suppression après (secondes)", c.emptyTimeoutSeconds) +
      saveBar() +
    "</div>";
  wireSave(() => ({
    tempVoice: {
      enabled: $("#enabled").checked,
      hubChannelIds: [...document.querySelectorAll(".hub:checked")].map((el) => el.value),
      categoryId: $("#categoryId").value || null,
      nameTemplate: $("#nameTemplate").value,
      userLimit: Number($("#userLimit").value),
      emptyTimeoutSeconds: Number($("#emptyTimeoutSeconds").value),
    },
  }));
}

async function viewAutoresponder(container) {
  const c = state.config.autoresponder;
  const roles = rolesBelowBot();
  header("Répondeur", "Réponses automatiques");
  container.innerHTML =
    '<div class="card">' +
      checkbox("enabled", "Activer le répondeur", c.enabled) +
      '<div id="rules">' + c.rules.map((r) => ruleRow(r, roles)).join("") + "</div>" +
      '<button class="btn ghost" id="add-rule" type="button">+ Ajouter une règle</button>' +
      saveBar() +
    "</div>";
  const rules = $("#rules");
  $("#add-rule").addEventListener("click", () => {
    rules.insertAdjacentHTML("beforeend", ruleRow({ id: String(Date.now()), trigger: "", match: "contains", reply: "", ignoreRoleId: null, cooldownSeconds: 300 }, roles));
  });
  rules.addEventListener("click", (event) => {
    if (event.target.classList.contains("rm")) event.target.closest(".rule-row").remove();
  });
  wireSave(() => ({
    autoresponder: {
      enabled: $("#enabled").checked,
      rules: [...document.querySelectorAll(".rule-row")].map((row) => ({
        id: row.dataset.id,
        trigger: row.querySelector(".r-trigger").value,
        match: row.querySelector(".r-match").value,
        reply: row.querySelector(".r-reply").value,
        ignoreRoleId: row.querySelector(".r-role").value || null,
        cooldownSeconds: Number(row.querySelector(".r-cd").value),
      })).filter((r) => r.trigger && r.reply),
    },
  }));
}

function ruleRow(rule, roles) {
  return '<div class="rule-row card" data-id="' + esc(rule.id) + '" style="margin-bottom:10px;background:var(--surface-2)">' +
    '<div class="row-3">' +
      '<div class="field"><label>Déclencheur</label><input class="r-trigger" type="text" value="' + esc(rule.trigger) + '"></div>' +
      '<div class="field"><label>Correspondance</label><select class="r-match">' +
        ["contains","exact","startsWith"].map((m) => '<option value="' + m + '"' + (m === rule.match ? " selected" : "") + ">" + m + "</option>").join("") +
      "</select></div>" +
      '<div class="field"><label>Délai (s)</label><input class="r-cd" type="number" value="' + esc(rule.cooldownSeconds) + '"></div>' +
    "</div>" +
    '<div class="field"><label>Réponse</label><textarea class="r-reply">' + esc(rule.reply) + "</textarea></div>" +
    '<div class="field"><label>Rôle ignoré</label><select class="r-role"><option value="">— aucun —</option>' +
      roles.map((r) => '<option value="' + esc(r.id) + '"' + (r.id === rule.ignoreRoleId ? " selected" : "") + ">" + esc(r.name) + "</option>").join("") +
    "</select></div>" +
    '<button class="btn ghost rm" type="button">Supprimer la règle</button></div>';
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function loadGuild() {
  state.guild = await api("/api/guilds/" + state.guildId);
  state.config = (await api("/api/guilds/" + state.guildId + "/config")).config;
}

async function boot() {
  const session = await api("/api/session");
  if (!session.authenticated) return renderLogin();
  state.csrf = session.csrf;

  const overview = await api("/api/overview");
  state.guilds = overview.guilds;
  if (state.guilds.length) {
    state.guildId = state.guildId || state.guilds[0].id;
    await loadGuild();
  }
  renderShell();
  await renderView();
}

boot().catch((err) => {
  root.innerHTML = '<div class="empty">Le tableau de bord n\\'a pas pu démarrer : ' + esc(err.message) + "</div>";
});
`;
}
