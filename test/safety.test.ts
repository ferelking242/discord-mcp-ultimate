import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIRMATION_PHRASES,
  confirmationPhrase,
  isDuplicateFingerprint,
  readAuditTrail,
  recordAction,
  resetAuditTrail,
  resetFingerprints,
  resetThrottle,
  resolveGate,
  runPaced,
  throttleBulk,
} from "../src/safety.js";

test("resolveGate previews by default and only applies on an explicit confirm", () => {
  assert.equal(resolveGate({}).preview, true, "a bare call must not mutate");
  assert.equal(resolveGate({ confirm: false }).preview, true);
  assert.equal(resolveGate({ confirm: true }).preview, false);
  assert.equal(resolveGate({ dry_run: true }).preview, true);
  assert.equal(resolveGate({ confirm: true, dry_run: false }).preview, false);
  // An explicit dry_run wins over confirm: the more cautious flag is honoured.
  assert.equal(resolveGate({ confirm: true, dry_run: true }).preview, true);
});

test("resolveGate's report carries the preview hint only while previewing", () => {
  const preview = resolveGate({}).report({ channel: "general" });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.requires_confirmation, true);
  assert.ok(typeof preview.hint === "string" && preview.hint.length > 0);

  const apply = resolveGate({ confirm: true }).report({ channel: "general" });
  assert.equal(apply.mode, "apply");
  assert.equal(apply.requires_confirmation, false);
  assert.equal(apply.hint, undefined);
});

test("the audit trail records newest-first and clamps its limit", () => {
  resetAuditTrail();
  for (let i = 0; i < 5; i += 1) {
    recordAction({ tool: `tool_${i}`, guildId: "g", summary: `did ${i}`, outcome: "applied" });
  }
  const entries = readAuditTrail(3);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.tool, "tool_4", "newest entry must come first");
  assert.equal(entries[2]!.tool, "tool_2");
  assert.ok(entries.every((e) => typeof e.timestamp === "string"));

  // A limit beyond the cap is clamped rather than throwing.
  assert.equal(readAuditTrail(10_000).length, 5);
  assert.equal(readAuditTrail(0).length, 1, "limit is clamped to at least one entry");
  resetAuditTrail();
});

test("the audit trail is capped and drops the oldest entries", () => {
  resetAuditTrail();
  for (let i = 0; i < 520; i += 1) {
    recordAction({ tool: "t", guildId: null, summary: `${i}`, outcome: "applied" });
  }
  const entries = readAuditTrail(500);
  assert.equal(entries.length, 500, "the trail must not grow past its cap");
  assert.equal(entries[0]!.summary, "519", "the newest entry survives");
  resetAuditTrail();
});

test("isDuplicateFingerprint flags a repeat inside the window and allows it after", async () => {
  resetFingerprints();
  assert.equal(isDuplicateFingerprint("plan-a", 50), false, "first sighting is not a duplicate");
  assert.equal(isDuplicateFingerprint("plan-a", 50), true, "immediate repeat is a duplicate");
  assert.equal(isDuplicateFingerprint("plan-b", 50), false, "a different plan is independent");
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(isDuplicateFingerprint("plan-a", 50), false, "expired fingerprints are forgotten");
  resetFingerprints();
});

test("confirmationPhrase is the single source of truth for the typed phrase", () => {
  assert.equal(confirmationPhrase("delete"), "CONFIRM DELETE");
  assert.deepEqual(CONFIRMATION_PHRASES, { delete: "CONFIRM DELETE" });
});

test("throttleBulk paces successive calls by at least the configured interval", async () => {
  resetThrottle();
  const start = Date.now();
  await throttleBulk();
  await throttleBulk();
  await throttleBulk();
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 500, `three calls should span >= 500ms of pacing, took ${elapsed}ms`);
  resetThrottle();
});

test("runPaced collects per-item failures instead of aborting the batch", async () => {
  resetThrottle();
  const items = ["a", "b", "c", "d"];
  const { results, failures } = await runPaced(items, async (item) => {
    if (item === "b" || item === "d") throw new Error(`refused ${item}`);
    return item.toUpperCase();
  });
  assert.deepEqual(results, ["A", "C"], "successes are kept");
  assert.equal(failures.length, 2);
  assert.deepEqual(
    failures.map((f) => f.item),
    ["b", "d"],
  );
  assert.match(failures[0]!.error, /refused b/);
  assert.equal(failures[0]!.index, 1, "the failing index is reported for resumption");
  resetThrottle();
});

test("runPaced on an empty list resolves without touching the limiter", async () => {
  resetThrottle();
  const { results, failures } = await runPaced([], async () => "never");
  assert.deepEqual(results, []);
  assert.deepEqual(failures, []);
});
