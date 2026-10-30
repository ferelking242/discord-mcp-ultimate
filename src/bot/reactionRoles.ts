import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Persistent reaction-role mappings.
 *
 * A mapping binds one (channel, message, emoji) triple to one role. The store is
 * plain JSON on disk so an operator can read and hand-edit it, and so a restart
 * does not silently drop every menu the server built.
 */

export const mappingSchema = z.object({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  messageId: z.string().min(1),
  emoji: z.string().min(1),
  roleId: z.string().min(1),
  /** Free-form label, used in listings. */
  label: z.string().optional(),
  createdAt: z.string(),
});

export type ReactionRole = z.infer<typeof mappingSchema>;

const fileSchema = z.object({
  version: z.literal(1),
  mappings: z.array(mappingSchema),
});

/** Normalizes an emoji so `:name:` and the literal character compare equal. */
export function normalizeEmoji(input: string): string {
  const named = input.match(/^<a?:(\w+):(\d+)>$/);
  if (named) return `:${named[1]}:`;
  return input.replace(/^\uFE0F/, "").trim();
}

/**
 * An in-memory index over the on-disk file. Reads are synchronous against the
 * index so the reaction handler never awaits the filesystem on the hot path;
 * writes go through `save` which serializes to a temp file and renames, so a
 * crash mid-write cannot truncate the store.
 */
export class ReactionRoleStore {
  private mappings: ReactionRole[] = [];
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = fileSchema.parse(JSON.parse(raw));
      this.mappings = parsed.mappings;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Reaction-role store at ${this.file} is unreadable or malformed: ${(err as Error).message}`,
          { cause: err },
        );
      }
      this.mappings = [];
    }
    this.loaded = true;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("ReactionRoleStore.load() must be awaited first");
  }

  all(): ReactionRole[] {
    this.assertLoaded();
    return [...this.mappings];
  }

  find(
    guildId: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ): ReactionRole | undefined {
    this.assertLoaded();
    const key = normalizeEmoji(emoji);
    return this.mappings.find(
      (m) =>
        m.guildId === guildId &&
        m.channelId === channelId &&
        m.messageId === messageId &&
        normalizeEmoji(m.emoji) === key,
    );
  }

  forMessage(channelId: string, messageId: string): ReactionRole[] {
    this.assertLoaded();
    return this.mappings.filter((m) => m.channelId === channelId && m.messageId === messageId);
  }

  /**
   * Adds a mapping. Re-adding the same triple with a different role replaces the
   * old one: a menu whose emoji already means something should not end up with
   * two roles on one reaction.
   */
  async add(entry: Omit<ReactionRole, "createdAt">): Promise<ReactionRole> {
    this.assertLoaded();
    const key = normalizeEmoji(entry.emoji);
    this.mappings = this.mappings.filter(
      (m) =>
        !(
          m.guildId === entry.guildId &&
          m.channelId === entry.channelId &&
          m.messageId === entry.messageId &&
          normalizeEmoji(m.emoji) === key
        ),
    );
    const mapping: ReactionRole = { ...entry, emoji: key, createdAt: new Date().toISOString() };
    this.mappings.push(mapping);
    await this.save();
    return mapping;
  }

  async remove(
    guildId: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<boolean> {
    this.assertLoaded();
    const key = normalizeEmoji(emoji);
    const before = this.mappings.length;
    this.mappings = this.mappings.filter(
      (m) =>
        !(
          m.guildId === guildId &&
          m.channelId === channelId &&
          m.messageId === messageId &&
          normalizeEmoji(m.emoji) === key
        ),
    );
    const changed = this.mappings.length !== before;
    if (changed) await this.save();
    return changed;
  }

  /** Drops every mapping pointing at a message that no longer exists. */
  async removeMessage(channelId: string, messageId: string): Promise<number> {
    this.assertLoaded();
    const before = this.mappings.length;
    this.mappings = this.mappings.filter(
      (m) => !(m.channelId === channelId && m.messageId === messageId),
    );
    const removed = before - this.mappings.length;
    if (removed) await this.save();
    return removed;
  }

  /** Serializes writes so two concurrent saves cannot interleave. */
  private async save(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, mappings: this.mappings }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, snapshot, "utf8");
      await rename(tmp, this.file);
    });
    await this.writing;
  }

  /**
   * Reloads the file when it changed on disk.
   *
   * The MCP tool surface and the bot run as separate processes that share this
   * file, so a menu created through an MCP tool call must reach the running bot.
   * Watching the file is what closes that loop without a restart.
   */
  async reloadIfChanged(): Promise<boolean> {
    try {
      const { stat } = await import("node:fs/promises");
      const s = await stat(this.file);
      if (this.lastMtimeMs !== undefined && s.mtimeMs === this.lastMtimeMs) return false;
      this.lastMtimeMs = s.mtimeMs;
      await this.load();
      this.loaded = true;
      return true;
    } catch {
      return false;
    }
  }

  private lastMtimeMs: number | undefined;

  /**
   * Watches the file and reloads on change. Returns a stop function. Used by the
   * bot; the MCP side only writes.
   */
  watch(onChange?: (count: number) => void): () => void {
    // A short poll rather than fs.watch: the rename-based write replaces the inode,
    // and fs.watch on the old inode stops firing after the first save.
    const timer = setInterval(() => {
      void this.reloadIfChanged().then((changed) => {
        if (changed) onChange?.(this.mappings.length);
      });
    }, 2000);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
