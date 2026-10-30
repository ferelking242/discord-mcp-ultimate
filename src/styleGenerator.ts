import { z } from "zod";

/**
 * Unicode style generator for Discord entity names.
 *
 * IMPORTANT LIMITATION, stated up front because it is easy to over-promise:
 * Discord does not let an application choose a font for channel, role or
 * category names. The client renders whatever glyphs the name contains with the
 * user's system font. What this module produces is *decorated text*: prefixes,
 * borders, separators, emoji and characters drawn from the Unicode decorative
 * and mathematical alphabets. There is no server-side font engine, and any tool
 * claiming to "apply a font" is misrepresenting what Discord supports.
 */

/** Discord's hard cap on channel, category, role and forum name length (grapheme-unaware). */
export const DISCORD_NAME_MAX = 100;

/**
 * Characters Discord strips or that render as nothing. They are rejected rather
 * than silently dropped so a model does not build a naming scheme around
 * decorations that will not survive the round trip.
 */
const INVISIBLE_CHARS = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

export const STYLE_IDS = [
  "minimal",
  "gaming",
  "cyberpunk",
  "futuristic",
  "luxury",
  "fantasy",
  "anime",
  "elegant",
  "geometric",
  "bordered",
  "emoji_lead",
  "fullwidth",
] as const;

export type StyleId = (typeof STYLE_IDS)[number];

/** A decorative style: how a bare name is turned into a display name. */
interface StyleDefinition {
  id: StyleId;
  label: string;
  description: string;
  /** Wraps a cleaned, lowercase, dash-separated slug. */
  decorate(slug: string, emoji: string): string;
  /** Style-appropriate emoji pool, indexed deterministically by slug length. */
  emojis: readonly string[];
}

/** Deterministic pick: same slug always yields the same decoration. */
function pick<T>(pool: readonly T[], seed: string): T {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) % 1_000_003;
  return pool[hash % pool.length]!;
}

/**
 * Collapses arbitrary user text into a lowercase, dash-separated slug.
 *
 * Letters and digits of every script are kept, not just ASCII: a channel named
 * `🇷🇺・русский` must slug to `русский`, not to nothing. Restricting this to
 * `[a-z0-9]` silently erased Cyrillic, Arabic, CJK, Devanagari and Thai names
 * and pushed them all onto the same fallback, which renamed six distinct
 * language channels to the identical name.
 */
export function slugify(input: string): string {
  return (
    input
      .normalize("NFKD")
      // Diacritics are stripped from Latin letters only. A blanket combining-mark
      // strip also decomposed Cyrillic `й` into `и`, turning `русский` into
      // `русскии`, and mangled Devanagari matras.
      .replace(/([a-zA-Z])[\u0300-\u036f]+/g, "$1")
      // Recompose, so Hangul Jamo and Cyrillic base+breve become single letters
      // again before the character class below runs.
      .normalize("NFC")
      .toLowerCase()
      .replace(/['’]/g, "")
      // Variation selectors are category Mn, so \p{M} below would keep them and
      // leave an invisible U+FE0F stranded in the name. Drop them explicitly.
      .replace(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, "")
      // \p{M} is kept: some scripts carry combining marks that are part of the word.
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
  );
}

/**
 * The first emoji in a name, or undefined.
 *
 * Used to carry an entity's existing emoji through a restyle. The flags are the
 * reason this matters: `🇷🇺・русский` renamed to `✦・русский` loses the only
 * language cue that works for a member who reads none of the offered languages.
 * Matching anywhere, not just at the start, so `━━・🏛️・START HERE・━━` keeps its
 * emoji too.
 */
export function extractEmoji(name: string): string | undefined {
  return name.match(EMOJI_PATTERN)?.[0];
}

/**
 * An emoji plus any trailing presentation selectors, keycaps, ZWJ sequences and
 * skin-tone modifiers, so multi-code-point emoji survive intact.
 */
const EMOJI_PATTERN =
  /(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:[\uFE0F\u20E3]|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*)/u;

/** Latin letters mapped to their Unicode Mathematical Bold counterparts. */
const FULLWIDTH_MAP: Record<string, string> = {
  a: "ａ",
  b: "ｂ",
  c: "ｃ",
  d: "ｄ",
  e: "ｅ",
  f: "ｆ",
  g: "ｇ",
  h: "ｈ",
  i: "ｉ",
  j: "ｊ",
  k: "ｋ",
  l: "ｌ",
  m: "ｍ",
  n: "ｎ",
  o: "ｏ",
  p: "ｐ",
  q: "ｑ",
  r: "ｒ",
  s: "ｓ",
  t: "ｔ",
  u: "ｕ",
  v: "ｖ",
  w: "ｗ",
  x: "ｘ",
  y: "ｙ",
  z: "ｚ",
  "-": "－",
  "0": "０",
  "1": "１",
  "2": "２",
  "3": "３",
  "4": "４",
  "5": "５",
  "6": "６",
  "7": "７",
  "8": "８",
  "9": "９",
};

/**
 * Maps ASCII to Unicode full-width forms. These are real Unicode code points,
 * so they render everywhere without a custom font, and they remain searchable
 * by their ASCII equivalent in most clients' quick switcher.
 */
function toFullwidth(slug: string): string {
  return [...slug].map((c) => FULLWIDTH_MAP[c] ?? c).join("");
}

const STYLES: Record<StyleId, StyleDefinition> = {
  minimal: {
    id: "minimal",
    label: "Minimal",
    description: "Lowercase slug with a single leading separator. No emoji, no borders.",
    decorate: (slug) => `・${slug}`,
    emojis: [""],
  },
  gaming: {
    id: "gaming",
    label: "Gaming",
    description: "Emoji-led name with a middot separator, common on gaming servers.",
    decorate: (slug, emoji) => `${emoji}・${slug}`,
    emojis: ["🎮", "🕹️", "🎯", "⚔️", "🏆", "🔥", "💥", "🎲"],
  },
  cyberpunk: {
    id: "cyberpunk",
    label: "Cyberpunk",
    description: "Bracket-wrapped name with neon-adjacent geometric marks.",
    decorate: (slug) => `【${slug}】`,
    emojis: ["🟣", "⚡", "🌐", "🛰️", "🧬"],
  },
  futuristic: {
    id: "futuristic",
    label: "Futuristic",
    description: "Sober leading glyph with a middot separator; restrained, not loud.",
    decorate: (slug) => `✦・${slug}`,
    emojis: ["✦", "◇", "◈", "⬡", "⟡"],
  },
  luxury: {
    id: "luxury",
    label: "Luxury",
    description: "Ornamental ꧁꧂ framing with a diamond separator.",
    decorate: (slug) => `꧁・${slug}・꧂`,
    emojis: ["💎", "👑", "🥂", "✨", "🕯️"],
  },
  fantasy: {
    id: "fantasy",
    label: "Fantasy",
    description: "Runic framing with star separators.",
    decorate: (slug) => `✧・${slug}・✧`,
    emojis: ["🗡️", "🛡️", "🧝", "🔮", "🐉", "🏰"],
  },
  anime: {
    id: "anime",
    label: "Anime",
    description: "Softer ୨୧ ornaments either side of the name.",
    decorate: (slug) => `୨୧・${slug}・୨୧`,
    emojis: ["🌸", "💫", "🎀", "🫧", "🌙"],
  },
  elegant: {
    id: "elegant",
    label: "Elegant",
    description: "Corner-bracket frame, minimal and typographic.",
    decorate: (slug) => `╭・${slug}`,
    emojis: ["", "❁", "❀"],
  },
  geometric: {
    id: "geometric",
    label: "Geometric",
    description: "Pure geometric glyphs, no emoji, no pictographs.",
    decorate: (slug) => `◈・${slug}・◈`,
    emojis: ["◇", "◆", "△", "▽", "⬢"],
  },
  bordered: {
    id: "bordered",
    label: "Bordered",
    description:
      "Full box-drawing frame. Emoji-aware, so it keeps a category's existing emoji inside the frame.",
    decorate: (slug, emoji) => (emoji ? `╭・${emoji}・${slug}・╮` : `╭・${slug}・╮`),
    emojis: [""],
  },
  emoji_lead: {
    id: "emoji_lead",
    label: "Emoji-led",
    description: "A leading emoji and a pipe separator; the Discord classic.",
    decorate: (slug, emoji) => `${emoji}︱${slug}`,
    emojis: ["📢", "💬", "📌", "🎫", "🤖", "🧩", "📊", "🛠️"],
  },
  fullwidth: {
    id: "fullwidth",
    label: "Full-width",
    description: "Unicode full-width letters: a decorative alphabet, not a font change.",
    decorate: (slug) => `・${toFullwidth(slug)}`,
    emojis: ["", "◆"],
  },
};

/** The style catalogue, safe to serialise to the model. */
export function listStyles(): { id: StyleId; label: string; description: string }[] {
  return Object.values(STYLES).map(({ id, label, description }) => ({ id, label, description }));
}

export function isStyleId(value: string): value is StyleId {
  return value in STYLES;
}

export interface StyledName {
  /** The decorated name, already clamped to Discord's limit. */
  name: string;
  /** The bare slug this name was derived from. */
  slug: string;
  /** The style applied. */
  style: StyleId;
  /** True when the input was empty after slugification and a fallback was used. */
  fallback: boolean;
  /** True when decoration had to be trimmed to fit {@link DISCORD_NAME_MAX}. */
  truncated: boolean;
}

export interface StyleOptions {
  style: StyleId;
  /** Explicit emoji to use where the style supports one. */
  emoji?: string;
  /** Upper bound on the produced name length. Defaults to {@link DISCORD_NAME_MAX}. */
  maxLength?: number;
  /**
   * Name used when the input slugifies to nothing. Pass the entity's real name
   * where one is known, so a rename never collapses two entities onto the same
   * generic word.
   */
  fallbackName?: string;
  /**
   * Carry the source name's own emoji into the result instead of letting the
   * style pick one. Keeps flags and per-channel icons intact across a restyle.
   */
  keepEmoji?: boolean;
}

/**
 * Decorates one name.
 *
 * Guarantees, in order:
 * 1. Invisible characters are stripped before anything else happens.
 * 2. An empty or punctuation-only input falls back to `fallbackName` (default
 *    `"channel"`), so the tool never returns a name Discord will reject.
 * 3. The result is clamped to `maxLength` by trimming the slug, never the
 *    decoration, so the name keeps a recognisable shape when it has to shrink.
 */
export function styleName(rawName: string, options: StyleOptions): StyledName {
  const style = STYLES[options.style];
  const cleaned = rawName.replace(new RegExp(INVISIBLE_CHARS, "g"), "");
  let slug = slugify(cleaned);
  let fallback = false;
  if (slug.length === 0) {
    slug = slugify(options.fallbackName ?? "") || "channel";
    fallback = true;
  }
  const emoji =
    options.emoji ??
    // Read the emoji from the raw name: the invisible-character strip above
    // removes U+200D, which would break every ZWJ emoji (🧑‍💻 into 🧑).
    (options.keepEmoji ? extractEmoji(rawName) : undefined) ??
    pick(style.emojis, slug);
  const maxLength = options.maxLength ?? DISCORD_NAME_MAX;

  let candidate = style.decorate(slug, emoji);
  let truncated = false;
  if ([...candidate].length > maxLength) {
    const budget = maxLength - ([...candidate].length - [...slug].length);
    slug = [...slug].slice(0, Math.max(1, budget)).join("");
    candidate = style.decorate(slug, emoji);
    truncated = true;
  }
  return { name: candidate, slug, style: options.style, fallback, truncated };
}

/** The entity kinds the generator understands; each gets a sensible default style. */
export const ENTITY_KINDS = [
  "category",
  "text_channel",
  "voice_channel",
  "forum_channel",
  "announcement_channel",
  "rules_channel",
  "support_channel",
  "community_channel",
  "role",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * Default style per entity kind. Categories get a frame, channels get an
 * emoji or middot lead, roles stay minimal so mentions remain readable.
 */
export const DEFAULT_STYLE_BY_KIND: Record<EntityKind, StyleId> = {
  category: "bordered",
  text_channel: "emoji_lead",
  voice_channel: "gaming",
  forum_channel: "geometric",
  announcement_channel: "futuristic",
  rules_channel: "elegant",
  support_channel: "emoji_lead",
  community_channel: "minimal",
  role: "minimal",
} as Record<EntityKind, StyleId>;

/**
 * Emoji pool keyed by entity kind, used when the caller supplies a theme rather
 * than an explicit emoji. Kept separate from the style pools so a "gaming"
 * theme still gives a voice channel a headset and a rules channel a scroll.
 */
const KIND_EMOJIS: Record<string, readonly string[]> = {
  category: ["📁", "🗂️", "◈", "▣"],
  text_channel: ["💬", "🗨️", "📝", "🧩"],
  voice_channel: ["🔊", "🎧", "🎙️", "🎵"],
  forum_channel: ["🧵", "💭", "🗳️", "📋"],
  announcement_channel: ["📢", "📣", "🗞️", "🔔"],
  rules_channel: ["📜", "📖", "⚖️", "🛡️"],
  support_channel: ["🎫", "🛠️", "🆘", "🧰"],
  community_channel: ["🌍", "🤝", "🏡", "✨"],
  role: ["", "◆", "◇"],
};

export interface NamingPlanItem {
  kind: EntityKind;
  /** The original, human-readable intent. */
  intent: string;
  name: string;
  slug: string;
  style: StyleId;
  emoji: string;
  fallback: boolean;
  truncated: boolean;
}

export interface NamingPlan {
  theme: StyleId;
  items: NamingPlanItem[];
  /** Collisions detected between produced names, with the offending intents. */
  collisions: { name: string; intents: string[] }[];
  warnings: string[];
}

export interface BuildNamingPlanInput {
  /** A global theme for the whole server. Overridden per item by `overrides`. */
  theme: StyleId;
  items: { kind: EntityKind; name: string; emoji?: string }[];
  /** Per-intent style override, keyed by the exact `name` given in `items`. */
  overrides?: Record<string, StyleId>;
  /** Prefix applied to every slug, e.g. a server-wide "wt-" namespace. */
  prefix?: string;
  /**
   * Use {@link DEFAULT_STYLE_BY_KIND} instead of the single `theme` for
   * decoration. Off by default, because a theme that every entity ignores is not
   * a theme: with this off, the whole server shares one decoration and only the
   * emoji varies by kind.
   */
  perKindDefaults?: boolean;
}

/**
 * Produces a coherent naming plan for a whole server.
 *
 * Coherence is the point: by default every entity is decorated by the same
 * theme, with only the emoji chosen per kind (a headset for voice, a scroll for
 * rules). Pass `perKindDefaults: true` to fall back to a different decoration
 * per kind instead. Collisions are reported rather than silently created, since
 * Discord allows duplicate channel names and they then become indistinguishable
 * in the channel list.
 */
export function buildNamingPlan(input: BuildNamingPlanInput): NamingPlan {
  const warnings: string[] = [];
  const items: NamingPlanItem[] = input.items.map((item) => {
    const style =
      input.overrides?.[item.name] ??
      (input.perKindDefaults ? (DEFAULT_STYLE_BY_KIND[item.kind] ?? input.theme) : input.theme);
    const emoji = item.emoji ?? pick(KIND_EMOJIS[item.kind] ?? [""], item.name);
    const styled = styleName(input.prefix ? `${input.prefix} ${item.name}` : item.name, {
      style,
      emoji,
    });
    if (styled.fallback) warnings.push(`"${item.name}" produced an empty slug; used a fallback.`);
    if (styled.truncated)
      warnings.push(`"${item.name}" was truncated to fit Discord's 100-char cap.`);
    return {
      kind: item.kind,
      intent: item.name,
      name: styled.name,
      slug: styled.slug,
      style,
      emoji,
      fallback: styled.fallback,
      truncated: styled.truncated,
    };
  });

  const byName = new Map<string, string[]>();
  for (const item of items) {
    byName.set(item.name, [...(byName.get(item.name) ?? []), item.intent]);
  }
  const collisions = [...byName.entries()]
    .filter(([, intents]) => intents.length > 1)
    .map(([name, intents]) => ({ name, intents }));

  return { theme: input.theme, items, collisions, warnings };
}

/** Zod schema for the style catalogue, reused by the tool definitions. */
export const styleIdSchema = z.enum(STYLE_IDS);

export const entityKindSchema = z.enum(ENTITY_KINDS);
