import chokidar, { type FSWatcher } from "chokidar";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BotRecord } from "@agentdesk/agent-feed-wire";
import { isAgentLogPath } from "@/bots/sessions/botSessionLogs";
import { ensureSessionSlots } from "@/bots/sessions/botSessionSlots";
import { acquireFileLock, writeJsonAtomically } from "@/config/lockedJsonFile";

export const BOT_STORE_VERSION = 3;

export interface BotIdempotencyRecord {
  signature: string;
  botId: string;
}

export interface StoredBotSnapshot {
  version: 3;
  revision: number;
  bots: BotRecord[];
  idempotency: Record<string, BotIdempotencyRecord>;
}

function emptySnapshot(): StoredBotSnapshot {
  return { version: BOT_STORE_VERSION, revision: 0, bots: [], idempotency: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isSessionRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.source === "claude" || value.source === "codex" || value.source === "pi" || value.source === "opencode") &&
    typeof value.sessionId === "string"
  );
}

function isSessionSlots(value: unknown): value is Record<string, number> | undefined {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => /^[A-Za-z]+:[A-Za-z0-9._:-]{1,128}$/.test(key)) &&
    Object.values(value).every((slot) => Number.isSafeInteger(slot) && Number(slot) >= 0)
  );
}

function isSessionAnchors(value: unknown): value is Record<string, string> | undefined {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => /^[A-Za-z]+:[A-Za-z0-9._:-]{1,128}$/.test(key)) &&
    Object.values(value).every(
      (anchor) => typeof anchor === "string" && anchor.length >= 1 && anchor.length <= 64 && !/[\n\r()]/.test(anchor),
    )
  );
}

function isSessionLogs(value: unknown): value is Record<string, string> | undefined {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => /^[A-Za-z]+:[A-Za-z0-9._:-]{1,128}$/.test(key)) &&
    Object.values(value).every((path) => isAgentLogPath(path))
  );
}

function isBotRecord(value: unknown): value is BotRecord {
  if (!isRecord(value) || !isRecord(value.environment) || !isRecord(value.metadata) || !isRecord(value.createdBy)) {
    return false;
  }
  const custom = value.metadata.custom;
  return (
    typeof value.botId === "string" &&
    typeof value.name === "string" &&
    isOptionalString(value.iconUrl) &&
    value.environment.kind === "directory" &&
    typeof value.environment.path === "string" &&
    Array.isArray(value.sessionRefs) &&
    value.sessionRefs.every(isSessionRef) &&
    isSessionSlots(value.sessionSlots) &&
    isSessionAnchors(value.sessionAnchors) &&
    isSessionLogs(value.sessionLogs) &&
    (value.nextSessionSlot === undefined ||
      (Number.isSafeInteger(value.nextSessionSlot) && Number(value.nextSessionSlot) >= 0)) &&
    isOptionalString(value.metadata.role) &&
    isOptionalString(value.metadata.description) &&
    Array.isArray(value.metadata.labels) &&
    value.metadata.labels.every((label) => typeof label === "string") &&
    isRecord(custom) &&
    Object.values(custom).every((entry) => typeof entry === "string") &&
    Array.isArray(value.grants) &&
    value.grants.every((grant) => grant === "add_bot") &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    (value.offCanvas === undefined || typeof value.offCanvas === "boolean") &&
    (value.canvasPosition === undefined ||
      (Number.isSafeInteger(value.canvasPosition) && Number(value.canvasPosition) >= 0)) &&
    (value.offCanvasSessionRefs === undefined ||
      (Array.isArray(value.offCanvasSessionRefs) && value.offCanvasSessionRefs.every(isSessionRef))) &&
    (value.fatherSession === undefined || isSessionRef(value.fatherSession)) &&
    (value.createdBy.kind === "user" || (value.createdBy.kind === "bot" && typeof value.createdBy.botId === "string"))
  );
}

function validateSnapshot(value: unknown): StoredBotSnapshot {
  if (!isRecord(value) || (value.version !== BOT_STORE_VERSION && value.version !== 2)) {
    throw new Error(`bots.json must have version ${BOT_STORE_VERSION}`);
  }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    throw new Error("bots.json revision must be a nonnegative integer");
  }
  if (!Array.isArray(value.bots) || !isRecord(value.idempotency)) {
    throw new Error("bots.json must contain bots and idempotency records");
  }
  if (!value.bots.every(isBotRecord)) {
    throw new Error("bots.json contains an invalid Bot record");
  }
  const bots = value.bots.map((bot) =>
    // Version 2 predates slots: backfill from the order its sessions already wear, so the
    // migration changes the stored shape and nothing the reader sees.
    bot.sessionSlots === undefined && bot.nextSessionSlot === undefined
      ? { ...bot, ...ensureSessionSlots(bot, bot.sessionRefs) }
      : bot,
  );
  const botIds = new Set(bots.map((bot) => bot.botId));
  if (botIds.size !== bots.length) {
    throw new Error("bots.json contains duplicate Bot ids");
  }
  // One Father per machine, which every write keeps (`updateBotRecord`). A file holding two is a
  // hand edit or an older sidecar's, and reading it would show one and hide the other.
  if (bots.filter((bot) => bot.fatherSession !== undefined).length > 1) {
    throw new Error("bots.json names more than one Father");
  }
  if (
    !Object.values(value.idempotency).every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.signature === "string" &&
        typeof entry.botId === "string" &&
        botIds.has(entry.botId),
    )
  ) {
    throw new Error("bots.json contains an invalid idempotency record");
  }
  return {
    version: BOT_STORE_VERSION,
    revision: value.revision,
    bots,
    idempotency: value.idempotency,
  } as unknown as StoredBotSnapshot;
}

/**
 * The one durable home of Bot identity.
 *
 * Mutations run through one promise tail, so concurrent API and tool calls validate against the
 * same latest snapshot and land as one atomic temp-file rename rather than overwriting each other.
 */
export class BotStore {
  private readonly loaded: Promise<StoredBotSnapshot>;
  private snapshotValue: StoredBotSnapshot = emptySnapshot();
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: StoredBotSnapshot) => void>();
  private watcher: Promise<FSWatcher> | null = null;
  /**
   * The teardown of the previous watch, so the next one opens behind it.
   *
   * The last reader leaving and the next arriving is the ordinary case, not an exotic one: it
   * is a panel tab closing and reopening, or a Vite reload. Those issue a close and an open on
   * one directory with nothing ordering them, and every watch in this process shares one
   * watcher thread, so the two contend for the lock that thread holds against the main thread.
   */
  private closing: Promise<void> | null = null;

  constructor(private readonly path: string) {
    this.loaded = this.load();
  }

  async snapshot(): Promise<StoredBotSnapshot> {
    await this.loaded;
    await this.mutationTail;
    this.snapshotValue = await this.readSnapshot();
    return structuredClone(this.snapshotValue);
  }

  /**
   * Watches for changes while anyone is listening, this process's own writes included.
   *
   * `mutate` announces the writes made here, so the watch exists for the ones made ELSEWHERE --
   * another sidecar, an editor, a script. That used to be covered by a one-second poll in the
   * registry that rebuilt a full snapshot per subscriber per second, whether or not anything had
   * changed. A file that changes a few times a day does not need to be asked 86,400 times.
   */
  subscribe(listener: (snapshot: StoredBotSnapshot) => void): () => void {
    this.listeners.add(listener);
    this.startWatching();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopWatching();
    };
  }

  private startWatching(): void {
    if (this.watcher) return;
    // The DIRECTORY, not the file: `write` lands as a temp file plus a `rename`, so the path being
    // watched is replaced rather than modified, and a watch bound to the old inode would see one
    // change and then nothing. `depth: 0` keeps it to that directory's own entries.
    const reload = (changed: string): void => {
      if (changed !== this.path) return;
      void this.announceExternalChange().catch((error) => {
        console.error("agent feed bot store reload failed", error);
      });
    };
    const opening = (this.closing ?? Promise.resolve()).then(() => {
      const watcher = chokidar.watch(dirname(this.path), {
        ignoreInitial: true,
        depth: 0,
        persistent: true,
        awaitWriteFinish: false,
      });
      watcher.on("add", reload);
      watcher.on("change", reload);
      watcher.on("unlink", reload);
      watcher.on("error", (error) => console.error("agent feed bot store watcher failed", error));
      // Stopped while it was still opening: nothing else holds this watch, because
      // `stopWatching` had no watcher to close when it ran.
      if (this.watcher !== opening) void watcher.close();
      return watcher;
    });
    this.watcher = opening;
  }

  private stopWatching(): void {
    const watcher = this.watcher;
    if (!watcher) return;
    this.watcher = null;
    // Recorded rather than awaited: unsubscribing cannot block. `startWatching` is what waits.
    const closed = watcher
      .then((opened) => opened.close())
      .catch((error: unknown) => console.error("agent feed bot store watcher close failed", error));
    this.closing = closed;
    void closed.finally(() => {
      if (this.closing === closed) this.closing = null;
    });
  }

  /**
   * Re-reads after a change on disk and announces it, unless it was ours.
   *
   * Gated on the revision because `mutate` already told the listeners about its own write, and the
   * rename it performed is what woke this up.
   */
  private async announceExternalChange(): Promise<void> {
    const latest = await this.readSnapshot();
    if (latest.revision === this.snapshotValue.revision) return;
    this.snapshotValue = latest;
    for (const listener of this.listeners) listener(structuredClone(latest));
  }

  mutate<T>(mutation: (snapshot: StoredBotSnapshot) => { snapshot: StoredBotSnapshot; value: T }): Promise<T> {
    const run = this.mutationTail.then(async () => {
      await this.loaded;
      const release = await acquireFileLock(this.path);
      try {
        const latest = await this.readSnapshot();
        const result = mutation(structuredClone(latest));
        await writeJsonAtomically(this.path, result.snapshot);
        this.snapshotValue = result.snapshot;
        for (const listener of this.listeners) listener(structuredClone(result.snapshot));
        return result.value;
      } finally {
        await release();
      }
    });
    this.mutationTail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private async load(): Promise<StoredBotSnapshot> {
    this.snapshotValue = await this.readSnapshot();
    return this.snapshotValue;
  }

  private async readSnapshot(): Promise<StoredBotSnapshot> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySnapshot();
      throw new Error(`failed to read bots.json at ${this.path}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`bots.json at ${this.path} is not valid JSON`, { cause: error });
    }
    return validateSnapshot(parsed);
  }
}
