import { z } from "zod";

import { JsonDocument } from "./store.js";

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

function sameKey(a: ReactionRole, b: Omit<ReactionRole, "createdAt">): boolean {
  return (
    a.guildId === b.guildId &&
    a.channelId === b.channelId &&
    a.messageId === b.messageId &&
    normalizeEmoji(a.emoji) === normalizeEmoji(b.emoji)
  );
}

/**
 * Reaction-role menus, over the shared JSON document.
 *
 * Reads are synchronous against the in-memory copy so the reaction handler never
 * awaits the filesystem on the hot path — a member reacting must not wait on disk.
 */
type FileShape = z.infer<typeof fileSchema>;

/**
 * The document type is the whole file, not the bare list, so the `version` field
 * stays on disk. An older build reads this file too, and dropping the wrapper
 * would make it fail to parse rather than fail loudly.
 */
export class ReactionRoleStore {
  private readonly doc: JsonDocument<FileShape>;

  constructor(file: string) {
    this.doc = new JsonDocument<FileShape>({
      file,
      create: () => ({ version: 1, mappings: [] }),
      normalize: (raw) => fileSchema.parse(raw),
    });
  }

  async load(): Promise<void> {
    await this.doc.load();
  }

  private assertLoaded(): void {
    if (!this.doc.isLoaded) throw new Error("ReactionRoleStore.load() must be awaited first");
  }

  all(): ReactionRole[] {
    this.assertLoaded();
    return [...this.doc.get().mappings];
  }

  find(
    guildId: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ): ReactionRole | undefined {
    this.assertLoaded();
    const key = normalizeEmoji(emoji);
    return this.doc
      .get()
      .mappings.find(
        (m) =>
          m.guildId === guildId &&
          m.channelId === channelId &&
          m.messageId === messageId &&
          normalizeEmoji(m.emoji) === key,
      );
  }

  forMessage(channelId: string, messageId: string): ReactionRole[] {
    this.assertLoaded();
    return this.doc
      .get()
      .mappings.filter((m) => m.channelId === channelId && m.messageId === messageId);
  }

  /**
   * Adds a mapping. Re-adding the same triple with a different role replaces the
   * old one: a menu whose emoji already means something should not end up with
   * two roles on one reaction.
   */
  async add(entry: Omit<ReactionRole, "createdAt">): Promise<ReactionRole> {
    this.assertLoaded();
    const mapping: ReactionRole = {
      ...entry,
      emoji: normalizeEmoji(entry.emoji),
      createdAt: new Date().toISOString(),
    };
    await this.doc.update((doc) => ({
      version: 1,
      mappings: [...doc.mappings.filter((m) => !sameKey(m, entry)), mapping],
    }));
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
    let changed = false;
    await this.doc.update((doc) => {
      const next = doc.mappings.filter(
        (m) =>
          !(
            m.guildId === guildId &&
            m.channelId === channelId &&
            m.messageId === messageId &&
            normalizeEmoji(m.emoji) === key
          ),
      );
      changed = next.length !== doc.mappings.length;
      return changed ? { version: 1, mappings: next } : undefined;
    });
    return changed;
  }

  /** Drops every mapping pointing at a message that no longer exists. */
  async removeMessage(channelId: string, messageId: string): Promise<number> {
    this.assertLoaded();
    let removed = 0;
    await this.doc.update((doc) => {
      const next = doc.mappings.filter(
        (m) => !(m.channelId === channelId && m.messageId === messageId),
      );
      removed = doc.mappings.length - next.length;
      return removed ? { version: 1, mappings: next } : undefined;
    });
    return removed;
  }

  /** See {@link JsonDocument.reloadIfChanged}: picks up the other process's writes. */
  reloadIfChanged(): Promise<boolean> {
    return this.doc.reloadIfChanged();
  }

  /** See {@link JsonDocument.watch}. Returns a stop function. */
  watch(onChange?: (count: number) => void): () => void {
    return this.doc.watch((data) => onChange?.(data.mappings.length));
  }
}
