/**
 * The dashboard's stylesheet.
 *
 * Kept as a string rather than a file so `tsc` ships it in `dist/` with no copy
 * step: a build that needs a second tool to move assets is a build that breaks
 * when someone runs `tsc` directly.
 */
export const DASHBOARD_CSS = `
:root {
  --bg: #0b0d12;
  --surface: #12151d;
  --surface-2: #181c26;
  --surface-3: #1f2431;
  --border: #262c3a;
  --text: #e6e9f0;
  --muted: #8b93a7;
  --accent: #7c5cff;
  --accent-soft: rgba(124, 92, 255, 0.14);
  --ok: #3fb950;
  --warn: #d29922;
  --danger: #f85149;
  --radius: 10px;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); }
h1, h2, h3 { margin: 0; font-weight: 600; }
h1 { font-size: 18px; }
h2 { font-size: 15px; }
h3 { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }

/* ── Login ─────────────────────────────────────────────────────────── */
.login-wrap { min-height: 100%; display: grid; place-items: center; padding: 24px; }
.login-card {
  width: 100%; max-width: 380px; background: var(--surface);
  border: 1px solid var(--border); border-radius: 14px; padding: 28px;
}
.login-card h1 { margin-bottom: 6px; }
.login-card p { color: var(--muted); margin: 0 0 20px; }
.login-mark {
  width: 44px; height: 44px; border-radius: 12px; margin-bottom: 16px;
  background: linear-gradient(135deg, var(--accent), #4c9aff);
  display: grid; place-items: center; font-size: 22px;
}

/* ── Layout ────────────────────────────────────────────────────────── */
.shell { display: grid; grid-template-columns: 260px 1fr; min-height: 100vh; }
.side {
  background: var(--surface); border-right: 1px solid var(--border);
  padding: 18px 14px; display: flex; flex-direction: column; gap: 6px;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 0 6px 16px; }
.brand-dot {
  width: 30px; height: 30px; border-radius: 9px; flex: none;
  background: linear-gradient(135deg, var(--accent), #4c9aff);
  display: grid; place-items: center; font-size: 15px;
}
.brand small { color: var(--muted); display: block; font-size: 11px; }
.nav { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
.nav button {
  all: unset; cursor: pointer; padding: 8px 10px; border-radius: 8px;
  color: var(--muted); font-size: 13px; display: flex; align-items: center; gap: 9px;
}
.nav button:hover { background: var(--surface-2); color: var(--text); }
.nav button.on { background: var(--accent-soft); color: var(--text); font-weight: 500; }
.nav button .ic { width: 16px; text-align: center; }
.nav .sep { height: 1px; background: var(--border); margin: 10px 6px; }

.main { padding: 26px 30px 60px; overflow-x: hidden; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
.top .who { color: var(--muted); font-size: 12px; }
.guild-pick {
  background: var(--surface-2); color: var(--text); border: 1px solid var(--border);
  border-radius: 8px; padding: 8px 10px; font-size: 13px; min-width: 200px;
}

/* ── Cards and forms ───────────────────────────────────────────────── */
.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px;
}
.card.wide { grid-column: 1 / -1; }
.stat { font-size: 26px; font-weight: 600; margin-top: 6px; }
.stat small { font-size: 12px; color: var(--muted); font-weight: 400; }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
.field .hint { font-size: 11px; color: var(--muted); margin-top: 4px; }
input[type="text"], input[type="number"], input[type="password"], textarea, select {
  width: 100%; background: var(--surface-2); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
  font: inherit; font-size: 13px;
}
textarea { resize: vertical; min-height: 74px; font-family: var(--mono); font-size: 12px; }
input:focus, textarea:focus, select:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.row-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.check { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; cursor: pointer; }
.check input { width: 16px; height: 16px; accent-color: var(--accent); }

button.btn {
  background: var(--accent); color: #fff; border: 0; border-radius: 8px;
  padding: 9px 16px; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
}
button.btn:hover { filter: brightness(1.1); }
button.btn:disabled { opacity: .5; cursor: not-allowed; }
button.btn.ghost { background: var(--surface-3); color: var(--text); }
button.btn.danger { background: var(--danger); }
.actions { display: flex; gap: 10px; align-items: center; margin-top: 18px; }

/* ── Tables ────────────────────────────────────────────────────────── */
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; font-weight: 500; }
tbody tr:hover { background: var(--surface-2); }
td.mono, .mono { font-family: var(--mono); font-size: 12px; }
.scroll { max-height: 460px; overflow-y: auto; }

/* ── Bits ──────────────────────────────────────────────────────────── */
.pill {
  display: inline-block; padding: 2px 9px; border-radius: 999px;
  font-size: 11px; font-weight: 500; background: var(--surface-3); color: var(--muted);
}
.pill.ok { background: rgba(63,185,80,.15); color: var(--ok); }
.pill.warn { background: rgba(210,153,34,.15); color: var(--warn); }
.pill.danger { background: rgba(248,81,73,.15); color: var(--danger); }
.pill.accent { background: var(--accent-soft); color: var(--accent); }
.toast {
  position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%);
  background: var(--surface-3); border: 1px solid var(--border); color: var(--text);
  padding: 11px 18px; border-radius: 10px; font-size: 13px; z-index: 50;
  box-shadow: 0 10px 30px rgba(0,0,0,.45); max-width: 90vw;
}
.toast.err { border-color: var(--danger); color: #ffd7d5; }
.toast.ok { border-color: var(--ok); }
.empty { color: var(--muted); text-align: center; padding: 34px 10px; }
.muted { color: var(--muted); }
.err-text { color: var(--danger); font-size: 12px; margin-top: 8px; }
.spin { display: inline-block; width: 13px; height: 13px; border: 2px solid var(--muted); border-top-color: transparent; border-radius: 50%; animation: sp .7s linear infinite; vertical-align: -2px; }
@keyframes sp { to { transform: rotate(360deg); } }
.hidden { display: none !important; }
@media (max-width: 820px) {
  .shell { grid-template-columns: 1fr; }
  .side { flex-direction: row; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--border); }
  .nav { flex-direction: row; flex-wrap: wrap; }
  .nav .sep { display: none; }
  .main { padding: 18px; }
  .row, .row-3 { grid-template-columns: 1fr; }
}
`;
