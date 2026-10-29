/**
 * Tool registry: aggregates all tool modules and provides a unified interface
 * for listing definitions and routing tool calls to the correct handler.
 *
 * To add a new tool module:
 * 1. Create a new file in this folder (e.g. `onboarding.ts`)
 * 2. Build it with `defineModule([...])` and default-export the result
 * 3. Import and add it to `allToolsets` below (the key is its `DISCORD_MCP_TOOLSETS` name)
 */

import type { ToolModule, ToolDefinition, ToolHandler, ToolResult } from "./types.js";

import discovery from "./discovery.js";
import messages from "./messages.js";
import channels from "./channels.js";
import permissions from "./permissions.js";
import members from "./members.js";
import roles from "./roles.js";
import moderation from "./moderation.js";
import screening from "./screening.js";
import stats from "./stats.js";
import forums from "./forums.js";
import webhooks from "./webhooks.js";
import scheduledEvents from "./scheduledEvents.js";
import invites from "./invites.js";
import dm from "./dm.js";
import guildSettings from "./guildSettings.js";
import botProfile from "./botProfile.js";
import style from "./style.js";
import serverArchitect from "./serverArchitect.js";
import automod from "./automod.js";
import expressions from "./expressions.js";
import backup from "./backup.js";
import diagnostics from "./diagnostics.js";
import scheduler from "./scheduler.js";

/** Every toolset, keyed by the name used in the `DISCORD_MCP_TOOLSETS` env var. */
const allToolsets: Record<string, ToolModule> = {
  discovery,
  messages,
  channels,
  permissions,
  members,
  roles,
  moderation,
  screening,
  stats,
  forums,
  webhooks,
  scheduled_events: scheduledEvents,
  invites,
  dm,
  guild_settings: guildSettings,
  bot_profile: botProfile,
  style,
  architect: serverArchitect,
  automod,
  expressions,
  backup,
  diagnostics,
  scheduler,
};

/**
 * Selects which toolsets to expose from `DISCORD_MCP_TOOLSETS` (comma-separated,
 * case-insensitive). Unset, empty, or `all` exposes everything; unknown names throw
 * at startup: a typo must not silently expose the full destructive surface.
 */
export function selectModules(): ToolModule[] {
  const raw = process.env.DISCORD_MCP_TOOLSETS?.trim();
  if (!raw) return Object.values(allToolsets);
  const names = [
    ...new Set(
      raw
        .split(",")
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (names.includes("all")) return Object.values(allToolsets);
  const unknown = names.filter((n) => !(n in allToolsets));
  if (unknown.length > 0 || names.length === 0) {
    throw new Error(
      `Invalid DISCORD_MCP_TOOLSETS: unknown toolset(s) ${unknown.map((n) => `"${n}"`).join(", ") || "(none selected)"}. ` +
        `Known: all, ${Object.keys(allToolsets).join(", ")}.`,
    );
  }
  return names.map((n) => allToolsets[n]);
}

const modules: ToolModule[] = selectModules();

/** One O(1) name→handler table merged from every module, built once at load. */
const registry: Map<string, ToolHandler> = (() => {
  const map = new Map<string, ToolHandler>();
  for (const mod of modules) {
    for (const [name, handler] of mod.handlers) {
      if (map.has(name)) throw new Error(`Duplicate tool name across modules: ${name}`);
      map.set(name, handler);
    }
  }
  return map;
})();

/** Merged name→schema-check table, parallel to {@link registry}. */
const inputValidators: Map<string, (args: Record<string, unknown>) => void> = (() => {
  const map = new Map<string, (args: Record<string, unknown>) => void>();
  for (const mod of modules) {
    for (const [name, validate] of mod.validators ?? []) map.set(name, validate);
  }
  return map;
})();

/**
 * Returns every tool definition across all modules.
 * Called on each tools/list request from the MCP client.
 */
export function getAllDefinitions(): ToolDefinition[] {
  return modules.flatMap((m) => m.definitions);
}

/** True if a tool with this name is registered (and not gated off). */
export function hasTool(name: string): boolean {
  return registry.has(name);
}

/**
 * Tools that must answer even when Discord is unreachable.
 *
 * These are the diagnostic and pure-computation tools. Gating them behind a
 * successful login would make them useless in exactly the situation they exist
 * for: a bot that cannot connect. `discord_verify_setup` in particular has to
 * run before a token is even configured, so the model can be told what is wrong
 * instead of receiving a bare connection error.
 */
const CONNECTION_FREE_TOOLS: ReadonlySet<string> = new Set([
  "discord_verify_setup",
  "discord_get_bot_profile_limits",
  "discord_architect_explain_limits",
  "discord_architect_plan",
  "discord_style_name",
  "discord_style_preview",
  "discord_list_name_styles",
]);

/** True if the tool can run without an established Discord connection. */
export function isConnectionFree(name: string): boolean {
  return CONNECTION_FREE_TOOLS.has(name);
}

/**
 * Validates a call's arguments against the tool's schema without running it.
 *
 * The server uses this to reject a malformed call before attempting to connect:
 * otherwise a bad `guild_id` would be reported as "DISCORD_TOKEN is required",
 * which sends the caller looking in the wrong place.
 * @throws {Error} If the tool is unknown or the arguments do not match its schema.
 */
export function validateToolArgs(name: string, args: Record<string, unknown>): void {
  const validator = inputValidators.get(name);
  if (!validator) throw new Error(`Unknown tool: ${name}`);
  validator(args);
}

/**
 * Routes a tool call to its handler via the merged registry.
 * @throws {Error} If no tool owns the given name.
 */
export async function handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const handler = registry.get(name);
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(args);
}
