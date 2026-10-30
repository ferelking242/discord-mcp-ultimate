import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISCORD_NAME_MAX,
  ENTITY_KINDS,
  STYLE_IDS,
  buildNamingPlan,
  isStyleId,
  listStyles,
  slugify,
  styleName,
} from "../src/styleGenerator.js";

test("the style catalogue is non-empty and self-consistent", () => {
  const styles = listStyles();
  assert.equal(styles.length, STYLE_IDS.length);
  for (const style of styles) {
    assert.ok(isStyleId(style.id), `${style.id} must be recognised by isStyleId`);
    assert.ok(style.label.length > 0);
    assert.ok(style.description.length > 0);
  }
  assert.ok(!isStyleId("not-a-style"));
});

test("slugify strips accents, punctuation and repeated dashes", () => {
  assert.equal(slugify("Général Discussion"), "general-discussion");
  assert.equal(slugify("  Annonces   de versions  "), "annonces-de-versions");
  assert.equal(slugify("L'équipe d'OpenHands"), "lequipe-dopenhands");
  assert.equal(slugify("***"), "");
});

test("slugify keeps non-Latin scripts instead of erasing them", () => {
  // Regression: an ASCII-only [a-z0-9] filter collapsed every one of these to
  // "", so six distinct language channels all fell back to the same name.
  assert.equal(slugify("🇷🇺・русский"), "русский");
  assert.equal(slugify("🇸🇦・العربية"), "العربية");
  assert.equal(slugify("🇯🇵・日本語"), "日本語");
  assert.equal(slugify("🇮🇳・हिन्दी"), "हिन्दी");
  assert.equal(slugify("🇹🇭・ไทย"), "ไทย");
  assert.equal(slugify("🇨🇳・中文"), "中文");
  assert.equal(slugify("🇰🇷・한국어"), "한국어");
});

test("styling distinct language channels yields distinct names", () => {
  const names = ["🇷🇺・русский", "🇸🇦・العربية", "🇯🇵・日本語", "🇮🇳・हिन्दी", "🇹🇭・ไทย"].map(
    (n) => styleName(n, { style: "futuristic" }).name,
  );
  assert.equal(new Set(names).size, names.length, `names collided: ${JSON.stringify(names)}`);
  for (const name of names) {
    assert.ok(!name.includes("channel"), `"${name}" fell back to the generic name`);
  }
});

test("styleName uses fallbackName so a rename keeps the entity's identity", () => {
  // A name that slugifies to nothing still gets a stable, distinct result when
  // the caller supplies the entity's real name.
  const a = styleName("✨✨", { style: "futuristic", fallbackName: "🇷🇺・русский" });
  const b = styleName("✨✨", { style: "futuristic", fallbackName: "🇯🇵・日本語" });
  assert.equal(a.fallback, true);
  assert.notEqual(a.name, b.name);
  assert.equal(a.slug, "русский");
});

test("styleName strips zero-width and other invisible characters", () => {
  const withInvisibles = "gene\u200Bral\u200D-\uFEFFchat\u00AD";
  const styled = styleName(withInvisibles, { style: "minimal" });
  for (const invisible of ["\u200B", "\u200D", "\uFEFF", "\u00AD"]) {
    assert.ok(!styled.name.includes(invisible), `invisible ${JSON.stringify(invisible)} survived`);
  }
  assert.equal(styled.slug, "general-chat");
});

test("styleName never returns an empty name: punctuation-only input falls back", () => {
  const styled = styleName("...", { style: "bordered" });
  assert.equal(styled.fallback, true);
  assert.equal(styled.slug, "channel");
  assert.ok(styled.name.length > 0);
  assert.match(styled.name, /channel/);
});

test("styleName honours an explicit emoji and a per-call max length", () => {
  const styled = styleName("general", { style: "emoji_lead", emoji: "💬" });
  assert.match(styled.name, /💬/);
  assert.equal(styled.truncated, false);

  const short = styleName("a-very-long-channel-name-here", { style: "bordered", maxLength: 12 });
  assert.equal(short.truncated, true);
  assert.ok(
    [...short.name].length <= 12,
    `expected <= 12 code points, got ${[...short.name].length}`,
  );
  assert.match(short.name, /╭/);
  assert.match(short.name, /╮/);
});

test("styleName is deterministic: the same slug always yields the same decoration", () => {
  const first = styleName("support", { style: "gaming" });
  const second = styleName("support", { style: "gaming" });
  assert.equal(first.name, second.name);
});

test("styleName clamps every style to Discord's 100-character cap", () => {
  const longName = "x".repeat(200);
  for (const style of STYLE_IDS) {
    const styled = styleName(longName, { style });
    assert.ok(
      [...styled.name].length <= DISCORD_NAME_MAX,
      `${style} produced ${[...styled.name].length} code points`,
    );
  }
});

test("every style produces a distinct, non-empty decoration", () => {
  const produced = new Map<string, string>();
  for (const style of STYLE_IDS) {
    const styled = styleName("general", { style, emoji: "💬" });
    assert.ok(styled.name.length > 0, `${style} produced nothing`);
    assert.ok(!produced.has(styled.name), `${style} collides with ${produced.get(styled.name)}`);
    produced.set(styled.name, style);
  }
});

test("buildNamingPlan keeps one theme across kinds and reports collisions", () => {
  const plan = buildNamingPlan({
    theme: "futuristic",
    items: [
      { kind: "category", name: "Accueil" },
      { kind: "text_channel", name: "general" },
      { kind: "voice_channel", name: "vocal" },
      { kind: "text_channel", name: "general" },
    ],
  });
  assert.equal(plan.items.length, 4);
  assert.equal(plan.collisions.length, 1);
  assert.equal(plan.collisions[0]!.intents.length, 2);
  for (const item of plan.items) {
    assert.equal(item.style, "futuristic", `${item.intent} should use the theme style`);
    assert.ok(item.name.length > 0);
  }
});

test("buildNamingPlan accepts a per-item style override and a namespace prefix", () => {
  const plan = buildNamingPlan({
    theme: "minimal",
    items: [{ kind: "text_channel", name: "support" }],
    overrides: { support: "bordered" },
    prefix: "wt",
  });
  assert.equal(plan.items[0]!.style, "bordered");
  assert.match(plan.items[0]!.slug, /^wt-support$/);
});

test("buildNamingPlan surfaces fallbacks and truncations as warnings", () => {
  const plan = buildNamingPlan({
    theme: "minimal",
    items: [
      { kind: "text_channel", name: "!!!" },
      { kind: "text_channel", name: "y".repeat(200) },
    ],
  });
  assert.equal(plan.warnings.length, 2);
  assert.ok(plan.warnings.some((w) => /empty slug/.test(w)));
  assert.ok(plan.warnings.some((w) => /truncated/.test(w)));
});

test("ENTITY_KINDS covers the channel and role shapes the architect needs", () => {
  for (const kind of [
    "category",
    "text_channel",
    "voice_channel",
    "forum_channel",
    "announcement_channel",
    "rules_channel",
    "support_channel",
    "role",
  ]) {
    assert.ok((ENTITY_KINDS as readonly string[]).includes(kind), `${kind} is missing`);
  }
});
