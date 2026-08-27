import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotRecord } from "@agentdesk/agent-feed-wire";

export const BOT_STORE_VERSION = 2;
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export interface BotIdempotencyRecord {
  signature: string;
  botId: string;
}

export interface StoredBotSnapshot {
  version: 2;
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
  return isRecord(value)
    && (value.source === "claude" || value.source === "codex" || value.source === "pi")
    && typeof value.sessionId === "string";
}

function isBotRecord(value: unknown): value is BotRecord {
  if (!isRecord(value) || !isRecord(value.environment) || !isRecord(value.metadata) || !isRecord(value.createdBy)) {
    return false;
  }
  const custom = value.metadata.custom;
  return typeof value.botId === "string"
    && typeof value.name === "string"
    && isOptionalString(value.iconUrl)
    && value.environment.kind === "directory"
    && typeof value.environment.path === "string"
    && Array.isArray(value.sessionRefs)
    && value.sessionRefs.every(isSessionRef)
    && isOptionalString(value.metadata.role)
    && isOptionalString(value.metadata.description)
    && Array.isArray(value.metadata.labels)
    && value.metadata.labels.every((label) => typeof label === "string")
    && isRecord(custom)
    && Object.values(custom).every((entry) => typeof entry === "string")
    && Array.isArray(value.grants)
    && value.grants.every((grant) => grant === "add_bot")
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt)
    && (
      value.createdBy.kind === "user"
      || (value.createdBy.kind === "bot" && typeof value.createdBy.botId === "string")
    );
}

function validateSnapshot(value: unknown): StoredBotSnapshot {
  if (!isRecord(value) || value.version !== BOT_STORE_VERSION) {
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
  const botIds = new Set(value.bots.map((bot) => bot.botId));
  if (botIds.size !== value.bots.length) {
    throw new Error("bots.json contains duplicate Bot ids");
  }
  if (!Object.values(value.idempotency).every((entry) =>
    isRecord(entry)
    && typeof entry.signature === "string"
    && typeof entry.botId === "string"
    && botIds.has(entry.botId)
  )) {
    throw new Error("bots.json contains an invalid idempotency record");
  }
  return value as unknown as StoredBotSnapshot;
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

  constructor(private readonly path: string) {
    this.loaded = this.load();
  }

  async snapshot(): Promise<StoredBotSnapshot> {
    await this.loaded;
    await this.mutationTail;
    this.snapshotValue = await this.readSnapshot();
    return structuredClone(this.snapshotValue);
  }

  subscribe(listener: (snapshot: StoredBotSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  mutate<T>(mutation: (snapshot: StoredBotSnapshot) => { snapshot: StoredBotSnapshot; value: T }): Promise<T> {
    const run = this.mutationTail.then(async () => {
      await this.loaded;
      const release = await this.acquireLock();
      try {
        const latest = await this.readSnapshot();
        const result = mutation(structuredClone(latest));
        await this.write(result.snapshot);
        this.snapshotValue = result.snapshot;
        for (const listener of this.listeners) listener(structuredClone(result.snapshot));
        return result.value;
      } finally {
        await release();
      }
    });
    this.mutationTail = run.then(() => {}, () => {});
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

  private async acquireLock(): Promise<() => Promise<void>> {
    const directory = dirname(this.path);
    const lockPath = `${this.path}.lock`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${process.pid}\n`, "utf8");
        } catch (error) {
          await handle.close();
          await rm(lockPath, { force: true });
          throw error;
        }
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          try {
            await handle.close();
          } finally {
            await rm(lockPath, { force: true });
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new Error(`failed to lock bots.json at ${this.path}`, { cause: error });
        }

        try {
          const lock = await stat(lockPath);
          if (Date.now() - lock.mtimeMs > STALE_LOCK_MS) {
            await rm(lockPath, { force: true });
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw new Error(`failed to inspect bots.json lock at ${lockPath}`, { cause: lockError });
        }

        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for bots.json lock at ${lockPath}`);
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
      }
    }
  }

  private async write(snapshot: StoredBotSnapshot): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.bots.${process.pid}.${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch (error) {
      try {
        await rm(temporary, { force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `failed to write and clean up bots.json at ${this.path}`);
      }
      throw error;
    }
  }
}
