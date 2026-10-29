/**
 * Shared safety primitives for every mutating tool: preview/confirm gating,
 * a per-process action audit trail, duplicate-work suppression and a small
 * serial rate limiter for bulk loops.
 *
 * The module is deliberately free of Discord imports so it stays trivially
 * testable and cannot accidentally issue a REST call.
 */

/** How a destructive tool wants to be gated. */
export type ConfirmationMode = "preview" | "apply";

/** Outcome of resolving a preview/confirm pair. */
export interface GateDecision {
  /** True when the caller only asked for a plan and no mutation may run. */
  preview: boolean;
  /** Machine-readable plan the tool can hand straight back to the model. */
  report: (plan: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Builds the standard preview/apply gate used by destructive tools.
 *
 * `confirm` defaults to false, so a model that calls a destructive tool without
 * thinking about it receives the plan instead of a deletion. Re-calling with
 * `confirm: true` performs the work. This mirrors the `dry_run` convention the
 * imported tool modules already use and adds a second, explicit acknowledgement
 * for operations that cannot be undone.
 */
export function resolveGate(args: { confirm?: boolean; dry_run?: boolean }): GateDecision {
  const preview = args.confirm === true ? args.dry_run === true : args.dry_run !== false;
  return {
    preview,
    report: (plan) => ({
      mode: preview ? "preview" : "apply",
      requires_confirmation: preview,
      plan,
      hint: preview
        ? "Nothing was changed. Re-call with confirm:true (and dry_run:false for tools that accept it) to apply."
        : undefined,
    }),
  };
}

// ─── Action audit trail ────────────────────────────────────────────────────────

export interface AuditRecord {
  timestamp: string;
  tool: string;
  guildId: string | null;
  summary: string;
  outcome: "applied" | "previewed" | "failed";
}

const MAX_AUDIT_RECORDS = 500;
const auditTrail: AuditRecord[] = [];

/**
 * Appends one entry to the in-process audit trail of what this MCP server did.
 *
 * This is the server's own record, not Discord's audit log: it survives only
 * for the lifetime of the process and is capped at {@link MAX_AUDIT_RECORDS}
 * entries so a long-running session cannot grow without bound.
 */
export function recordAction(record: Omit<AuditRecord, "timestamp">): void {
  auditTrail.push({ timestamp: new Date().toISOString(), ...record });
  if (auditTrail.length > MAX_AUDIT_RECORDS)
    auditTrail.splice(0, auditTrail.length - MAX_AUDIT_RECORDS);
}

/** Most recent entries first. `limit` is clamped to the trail's cap. */
export function readAuditTrail(limit = 50): AuditRecord[] {
  return auditTrail.slice(-Math.max(1, Math.min(limit, MAX_AUDIT_RECORDS))).reverse();
}

/** Clears the trail. Only used by tests. */
export function resetAuditTrail(): void {
  auditTrail.length = 0;
}

// ─── Loop / duplicate-work protection ──────────────────────────────────────────

const recentFingerprints = new Map<string, number>();

/**
 * Returns true the first time a fingerprint is seen and false for a repeat
 * inside `windowMs`. Bulk builders call it before creating an entity so a model
 * that loops on the same plan cannot create the same channel or role twice.
 */
export function isDuplicateFingerprint(fingerprint: string, windowMs = 60_000): boolean {
  const now = Date.now();
  for (const [key, seenAt] of recentFingerprints) {
    if (now - seenAt > windowMs) recentFingerprints.delete(key);
  }
  if (recentFingerprints.has(fingerprint)) return true;
  recentFingerprints.set(fingerprint, now);
  return false;
}

/** Clears the fingerprint cache. Only used by tests. */
export function resetFingerprints(): void {
  recentFingerprints.clear();
}

// ─── Serial rate limiting ──────────────────────────────────────────────────────

/**
 * Minimum spacing between outbound calls inside a bulk loop, in milliseconds.
 *
 * Discord's per-route buckets are enforced by discord.js, which already waits on
 * 429 responses. This limiter exists for a different reason: a structural build
 * can fire dozens of channel creations back to back, and pacing them keeps the
 * bot inside the global bucket instead of relying on retry-after backoff.
 */
const BULK_MIN_INTERVAL_MS = 250;

let lastBulkCall = 0;

/** Awaits the shared bulk-call interval. Call before each item of a bulk loop. */
export async function throttleBulk(): Promise<void> {
  const now = Date.now();
  const wait = BULK_MIN_INTERVAL_MS - (now - lastBulkCall);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastBulkCall = Date.now();
}

/** Resets the limiter clock. Only used by tests. */
export function resetThrottle(): void {
  lastBulkCall = 0;
}

/**
 * Runs `worker` over `items` one at a time, pacing each call and collecting
 * per-item failures instead of aborting the whole batch. A resumed build (see
 * `serverArchitect`) depends on this: one bad channel must not strand the rest.
 */
export async function runPaced<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
): Promise<{ results: R[]; failures: { index: number; item: T; error: string }[] }> {
  const results: R[] = [];
  const failures: { index: number; item: T; error: string }[] = [];
  for (const [index, item] of items.entries()) {
    await throttleBulk();
    try {
      results.push(await worker(item, index));
    } catch (err) {
      failures.push({ index, item, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results, failures };
}

// ─── Confirmation of irreversible operations ───────────────────────────────────

/**
 * The single source of truth for the typed acknowledgement an irreversible
 * operation requires.
 *
 * Tools enforce this through their Zod schema (`.literal(confirmationPhrase(...))`)
 * rather than a runtime check, so the requirement is advertised in the tool's
 * `inputSchema` and a wrong phrase is rejected before the server even tries to
 * reach Discord. A schema-level constraint is also visible to the model in
 * `tools/list`, which a handler-side assertion would not be.
 *
 * A literal phrase rather than a boolean is deliberate: a boolean can be
 * defaulted, and a defaulted boolean is a decision nobody made. A phrase has to
 * be produced by the model, which means the model had to decide to produce it.
 */
export const CONFIRMATION_PHRASES = {
  delete: "CONFIRM DELETE",
} as const;

/** The operations that need a typed acknowledgement. */
export type ConfirmableOperation = keyof typeof CONFIRMATION_PHRASES;

/** The exact string a caller must pass in `confirmation` to proceed. */
export function confirmationPhrase(operation: ConfirmableOperation): string {
  return CONFIRMATION_PHRASES[operation];
}
