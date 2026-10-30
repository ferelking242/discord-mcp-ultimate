import { z } from "zod";

import { JsonDocument } from "./store.js";

/**
 * Runtime state for the bot's features.
 *
 * Each concern is a small list of records in its own JSON file. A shared
 * {@link CollectionStore} holds the read/write mechanics so the subclasses only
 * express their own queries, and so there is one place where atomic writes and
 * cross-process reloading are handled.
 *
 * What is deliberately *not* here: message content, member profiles, anything
 * Discord already stores. A bot that mirrors a server's data into files it has to
 * keep in sync is a bot that drifts. These are only the facts Discord cannot tell
 * us — who warned whom, how much XP a member has, which ticket is whose.
 */

const snowflake = z.string().regex(/^\d{17,20}$/);
const iso = z.string();

/** Shared mechanics for a list of records in one JSON file. */
export class CollectionStore<T> {
  protected readonly doc: JsonDocument<{ version: 1; items: T[] }>;

  constructor(
    file: string,
    private readonly itemSchema: z.ZodType<T>,
    debounceMs = 0,
  ) {
    const fileSchema = z.object({ version: z.literal(1), items: z.array(itemSchema) });
    this.doc = new JsonDocument<{ version: 1; items: T[] }>({
      file,
      create: () => ({ version: 1, items: [] }),
      normalize: (raw) => fileSchema.parse(raw) as { version: 1; items: T[] },
      debounceMs,
    });
  }

  async load(): Promise<void> {
    await this.doc.load();
  }

  /** Writes any pending change immediately. Call before shutdown. */
  async flush(): Promise<void> {
    await this.doc.flush();
  }

  all(): T[] {
    return [...this.doc.get().items];
  }

  where(predicate: (item: T) => boolean): T[] {
    return this.doc.get().items.filter(predicate);
  }

  first(predicate: (item: T) => boolean): T | undefined {
    return this.doc.get().items.find(predicate);
  }

  count(predicate?: (item: T) => boolean): number {
    const items = this.doc.get().items;
    return predicate ? items.filter(predicate).length : items.length;
  }

  async add(item: T): Promise<T> {
    const parsed = this.itemSchema.parse(item);
    await this.doc.update((d) => ({ version: 1, items: [...d.items, parsed] }));
    return parsed;
  }

  /** Replaces the first match. Returns the replacement, or undefined if none matched. */
  async replace(predicate: (item: T) => boolean, item: T): Promise<T | undefined> {
    const parsed = this.itemSchema.parse(item);
    let found = false;
    await this.doc.update((d) => {
      const items = d.items.map((existing) => {
        if (!found && predicate(existing)) {
          found = true;
          return parsed;
        }
        return existing;
      });
      return found ? { version: 1, items } : undefined;
    });
    return found ? parsed : undefined;
  }

  /** Removes every match. Returns how many were removed. */
  async remove(predicate: (item: T) => boolean): Promise<number> {
    let removed = 0;
    await this.doc.update((d) => {
      const items = d.items.filter((item) => {
        if (predicate(item)) {
          removed++;
          return false;
        }
        return true;
      });
      return removed > 0 ? { version: 1, items } : undefined;
    });
    return removed;
  }

  reloadIfChanged(): Promise<boolean> {
    return this.doc.reloadIfChanged();
  }

  watch(onChange?: (items: T[]) => void): () => void {
    return this.doc.watch((data) => onChange?.(data.items));
  }
}

// ─── Moderation ────────────────────────────────────────────────────────────────

export const CASE_TYPES = [
  "ban",
  "unban",
  "kick",
  "timeout",
  "untimeout",
  "warn",
  "note",
  "softban",
  "purge",
] as const;
export type CaseType = (typeof CASE_TYPES)[number];

export const moderationCaseSchema = z.object({
  /** Sequential per guild, starting at 1. The number a moderator quotes. */
  number: z.int().min(1),
  guildId: snowflake,
  type: z.enum(CASE_TYPES),
  targetId: snowflake,
  targetTag: z.string().max(100),
  moderatorId: snowflake,
  moderatorTag: z.string().max(100),
  reason: z.string().max(1000),
  durationMs: z.int().min(0).nullable().default(null),
  createdAt: iso,
  /** False once a ban is lifted or a timeout expires. */
  active: z.boolean().default(true),
});

export type ModerationCase = z.infer<typeof moderationCaseSchema>;

/**
 * The guild's moderation history.
 *
 * Discord's own audit log is not usable as a record: it is paginated, it is
 * pruned, it does not carry reasons for every action type, and it cannot be
 * searched by target. This is the case file a moderator actually needs.
 */
export class ModerationStore extends CollectionStore<ModerationCase> {
  constructor(file: string) {
    super(file, moderationCaseSchema);
  }

  /** The next case number for a guild. Never reuses a number, even after deletion. */
  nextNumber(guildId: string): number {
    const numbers = this.where((c) => c.guildId === guildId).map((c) => c.number);
    return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
  }

  forTarget(guildId: string, targetId: string): ModerationCase[] {
    return this.where((c) => c.guildId === guildId && c.targetId === targetId);
  }

  byNumber(guildId: string, number: number): ModerationCase | undefined {
    return this.first((c) => c.guildId === guildId && c.number === number);
  }

  activeFor(guildId: string, targetId: string): ModerationCase[] {
    return this.where((c) => c.guildId === guildId && c.targetId === targetId && c.active);
  }
}

// ─── Levels ────────────────────────────────────────────────────────────────────

export const levelRecordSchema = z.object({
  guildId: snowflake,
  userId: snowflake,
  xp: z.int().min(0).default(0),
  level: z.int().min(0).default(0),
  messages: z.int().min(0).default(0),
  /** Epoch ms of the last XP grant, for the per-member cooldown. */
  lastXpAt: z.int().min(0).default(0),
  updatedAt: iso,
});

export type LevelRecord = z.infer<typeof levelRecordSchema>;

/** XP totals. Writes are debounced: an XP grant per message must not mean a disk write per message. */
export class LevelStore extends CollectionStore<LevelRecord> {
  constructor(file: string, debounceMs = 5000) {
    super(file, levelRecordSchema, debounceMs);
  }

  for(guildId: string, userId: string): LevelRecord {
    return (
      this.first((r) => r.guildId === guildId && r.userId === userId) ?? {
        guildId,
        userId,
        xp: 0,
        level: 0,
        messages: 0,
        lastXpAt: 0,
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  /** Leaderboard for one guild, highest XP first. */
  leaderboard(guildId: string, limit = 10): LevelRecord[] {
    return this.where((r) => r.guildId === guildId)
      .sort((a, b) => b.xp - a.xp)
      .slice(0, limit);
  }

  /** The member's 1-based rank, or 0 when they have no record. */
  rank(guildId: string, userId: string): number {
    const sorted = this.where((r) => r.guildId === guildId).sort((a, b) => b.xp - a.xp);
    const index = sorted.findIndex((r) => r.userId === userId);
    return index === -1 ? 0 : index + 1;
  }
}

// ─── Tickets ───────────────────────────────────────────────────────────────────

export const ticketSchema = z.object({
  number: z.int().min(1),
  guildId: snowflake,
  channelId: snowflake,
  userId: snowflake,
  userTag: z.string().max(100),
  subject: z.string().max(200).default(""),
  status: z.enum(["open", "closed"]).default("open"),
  claimedBy: snowflake.nullable().default(null),
  createdAt: iso,
  closedAt: iso.nullable().default(null),
  closedBy: snowflake.nullable().default(null),
});

export type Ticket = z.infer<typeof ticketSchema>;

export class TicketStore extends CollectionStore<Ticket> {
  constructor(file: string) {
    super(file, ticketSchema);
  }

  nextNumber(guildId: string): number {
    const numbers = this.where((t) => t.guildId === guildId).map((t) => t.number);
    return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
  }

  open(guildId: string): Ticket[] {
    return this.where((t) => t.guildId === guildId && t.status === "open");
  }

  openFor(guildId: string, userId: string): Ticket[] {
    return this.where((t) => t.guildId === guildId && t.userId === userId && t.status === "open");
  }

  byChannel(channelId: string): Ticket | undefined {
    return this.first((t) => t.channelId === channelId);
  }
}

// ─── Giveaways ─────────────────────────────────────────────────────────────────

export const giveawaySchema = z.object({
  guildId: snowflake,
  channelId: snowflake,
  messageId: snowflake,
  hostId: snowflake,
  prize: z.string().min(1).max(200),
  winnerCount: z.int().min(1).max(100).default(1),
  /** Entrants, by user id. */
  entrants: z.array(snowflake).default([]),
  winnerIds: z.array(snowflake).default([]),
  endsAt: z.int().min(0),
  ended: z.boolean().default(false),
  requiredRoleId: snowflake.nullable().default(null),
  minAccountAgeDays: z.int().min(0).default(0),
  createdAt: iso,
});

export type Giveaway = z.infer<typeof giveawaySchema>;

export class GiveawayStore extends CollectionStore<Giveaway> {
  constructor(file: string) {
    super(file, giveawaySchema);
  }

  byMessage(messageId: string): Giveaway | undefined {
    return this.first((g) => g.messageId === messageId);
  }

  /** Giveaways whose deadline has passed and that have not been drawn. */
  due(now: number = Date.now()): Giveaway[] {
    return this.where((g) => !g.ended && g.endsAt <= now);
  }

  active(guildId: string): Giveaway[] {
    return this.where((g) => g.guildId === guildId && !g.ended);
  }

  async addEntrant(
    messageId: string,
    userId: string,
  ): Promise<{ added: boolean; giveaway?: Giveaway }> {
    const giveaway = this.byMessage(messageId);
    if (!giveaway || giveaway.ended) return { added: false };
    if (giveaway.entrants.includes(userId)) return { added: false, giveaway };
    const updated = { ...giveaway, entrants: [...giveaway.entrants, userId] };
    await this.replace((g) => g.messageId === messageId, updated);
    return { added: true, giveaway: updated };
  }

  async removeEntrant(messageId: string, userId: string): Promise<boolean> {
    const giveaway = this.byMessage(messageId);
    if (!giveaway || !giveaway.entrants.includes(userId)) return false;
    await this.replace((g) => g.messageId === messageId, {
      ...giveaway,
      entrants: giveaway.entrants.filter((id) => id !== userId),
    });
    return true;
  }
}

// ─── Starboard ─────────────────────────────────────────────────────────────────

export const starboardEntrySchema = z.object({
  guildId: snowflake,
  sourceChannelId: snowflake,
  sourceMessageId: snowflake,
  starboardMessageId: snowflake,
  authorId: snowflake,
  starCount: z.int().min(0).default(0),
  postedAt: iso,
});

export type StarboardEntry = z.infer<typeof starboardEntrySchema>;

export class StarboardStore extends CollectionStore<StarboardEntry> {
  constructor(file: string) {
    super(file, starboardEntrySchema);
  }

  bySource(sourceMessageId: string): StarboardEntry | undefined {
    return this.first((e) => e.sourceMessageId === sourceMessageId);
  }

  async setStars(sourceMessageId: string, starCount: number): Promise<StarboardEntry | undefined> {
    const entry = this.bySource(sourceMessageId);
    if (!entry) return undefined;
    return this.replace((e) => e.sourceMessageId === sourceMessageId, { ...entry, starCount });
  }
}

// ─── Temporary voice channels ──────────────────────────────────────────────────

export const tempVoiceSchema = z.object({
  guildId: snowflake,
  channelId: snowflake,
  ownerId: snowflake,
  createdAt: iso,
});

export type TempVoiceChannel = z.infer<typeof tempVoiceSchema>;

export class TempVoiceStore extends CollectionStore<TempVoiceChannel> {
  constructor(file: string) {
    super(file, tempVoiceSchema);
  }

  byChannel(channelId: string): TempVoiceChannel | undefined {
    return this.first((c) => c.channelId === channelId);
  }

  ownedBy(guildId: string, ownerId: string): TempVoiceChannel[] {
    return this.where((c) => c.guildId === guildId && c.ownerId === ownerId);
  }
}

// ─── Autoresponder cooldowns ───────────────────────────────────────────────────

export const cooldownSchema = z.object({
  guildId: snowflake,
  userId: snowflake,
  ruleId: z.string(),
  lastAt: z.int().min(0),
});

export type CooldownRecord = z.infer<typeof cooldownSchema>;

/**
 * Per-member, per-rule reply cooldowns.
 *
 * Without this a single phrase becomes a way to make the bot repeat itself until
 * it is muted, which is the usual reason autoresponders get removed from servers.
 * Old entries are pruned on read rather than on a timer, so the file cannot grow
 * without bound in a busy guild.
 */
export class CooldownStore extends CollectionStore<CooldownRecord> {
  constructor(
    file: string,
    private readonly maxAgeMs = 86_400_000,
  ) {
    super(file, cooldownSchema);
  }

  /** True when the reply is allowed, and records it if so. */
  async allow(
    guildId: string,
    userId: string,
    ruleId: string,
    windowMs: number,
    now: number = Date.now(),
  ): Promise<boolean> {
    const existing = this.first(
      (c) => c.guildId === guildId && c.userId === userId && c.ruleId === ruleId,
    );
    if (existing && now - existing.lastAt < windowMs) return false;
    const record: CooldownRecord = { guildId, userId, ruleId, lastAt: now };
    if (existing) {
      await this.replace(
        (c) => c.guildId === guildId && c.userId === userId && c.ruleId === ruleId,
        record,
      );
    } else {
      await this.add(record);
    }
    return true;
  }

  /** Drops entries older than `maxAgeMs`. Returns how many were pruned. */
  async prune(now: number = Date.now()): Promise<number> {
    return this.remove((c) => now - c.lastAt > this.maxAgeMs);
  }
}
