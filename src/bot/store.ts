import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A single JSON document on disk, safe to share between processes.
 *
 * The bot and the MCP tool server are separate processes over one repository, and
 * they both need the same configuration. Rather than a database — which would be a
 * second thing to install, back up and keep running for a self-hosted bot — each
 * concern is one JSON file, written atomically and watched for changes.
 *
 * Three properties matter here, and each has a reason:
 *
 * - **Atomic write.** The bytes go to a temp file and are renamed over the target.
 *   A reader never sees a half-written document, and a crash mid-write leaves the
 *   previous version intact.
 * - **Serialized writes.** Two concurrent `update` calls queue instead of
 *   interleaving, so the last write always reflects both changes.
 * - **Debounced flush.** A message counter incremented on every message would
 *   otherwise mean a disk write per message. `update` marks dirty and schedules one
 *   flush.
 *
 * Nothing here validates the document's shape beyond parsing it: callers pass a
 * `normalize` function that turns unknown input into their own type, which keeps
 * the schema with the code that owns it.
 */
export interface JsonDocumentOptions<T> {
  /** File path. Parent directories are created on first write. */
  file: string;
  /** The document when the file does not exist yet. */
  create: () => T;
  /** Turns parsed JSON into `T`, or throws to reject a malformed file. */
  normalize: (raw: unknown) => T;
  /** Milliseconds to coalesce writes. 0 writes on every update. */
  debounceMs?: number;
}

/** Short digest of a document's bytes, used only to detect a change. */
function signature(text: string): string {
  return createHash("sha1").update(text).digest("base64url");
}

export class JsonDocument<T> {
  private data: T;
  private loaded = false;
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();
  private flushTimer: NodeJS.Timeout | undefined;
  /**
   * Digest of the bytes we last read or wrote.
   *
   * A content digest rather than an mtime: two writers within the same millisecond
   * produce the same mtime, and the second write would then be missed. Reading a
   * small JSON file on a poll is cheaper than that class of bug.
   */
  private lastSignature: string | undefined;
  private readonly debounceMs: number;

  constructor(private readonly opts: JsonDocumentOptions<T>) {
    this.data = opts.create();
    this.debounceMs = opts.debounceMs ?? 0;
  }

  /** Reads the file. A missing file yields the empty document; a corrupt one throws. */
  async load(): Promise<T> {
    try {
      const text = await readFile(this.opts.file, "utf8");
      this.data = this.opts.normalize(JSON.parse(text));
      this.lastSignature = signature(text);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = this.opts.create();
      } else {
        throw new Error(
          `Store at ${this.opts.file} is unreadable or malformed: ${(err as Error).message}`,
          { cause: err },
        );
      }
    }
    this.loaded = true;
    return this.data;
  }

  /** The in-memory document. Call `load` first. */
  get(): T {
    return this.data;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Applies a change and persists it. The mutator may modify the draft in place or
   * return a replacement. Returns the document after the change.
   */
  async update(mutator: (draft: T) => T | void): Promise<T> {
    const result = mutator(this.data);
    if (result !== undefined) this.data = result;
    this.dirty = true;
    if (this.debounceMs > 0) {
      this.scheduleFlush();
      return this.data;
    }
    await this.flush();
    return this.data;
  }

  /** Writes now if anything is pending. Safe to call when nothing is. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.dirty) {
      await this.writing;
      return;
    }
    this.dirty = false;
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.opts.file), { recursive: true });
      const tmp = `${this.opts.file}.tmp`;
      await writeFile(tmp, snapshot, "utf8");
      await rename(tmp, this.opts.file);
      // Record our own write so the next poll does not read it back as external.
      this.lastSignature = signature(snapshot);
    });
    await this.writing;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.debounceMs);
    this.flushTimer.unref?.();
  }

  /**
   * Reloads when the file's contents changed, so a change made by the other process
   * is picked up. Returns whether anything was reloaded.
   */
  async reloadIfChanged(): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(this.opts.file, "utf8");
    } catch {
      return false;
    }
    if (signature(text) === this.lastSignature) return false;
    this.data = this.opts.normalize(JSON.parse(text));
    this.lastSignature = signature(text);
    return true;
  }

  /**
   * Polls for external changes. A poll rather than `fs.watch` because the atomic
   * rename replaces the inode, and a watcher bound to the old one stops firing.
   * Returns a stop function.
   */
  watch(onChange?: (data: T) => void, intervalMs = 2000): () => void {
    const timer = setInterval(() => {
      void this.reloadIfChanged().then((changed) => {
        if (changed) onChange?.(this.data);
      });
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
