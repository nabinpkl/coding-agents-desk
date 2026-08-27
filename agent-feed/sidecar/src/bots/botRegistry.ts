import { stat } from "node:fs/promises";
import type {
  AddBotCommand,
  AttachBotSessionsCommand,
  BotCreatedBy,
  BotGrant,
  BotMetadata,
  BotRecord,
  BotSessionRef,
  BotSnapshot,
  BotView,
  DetachBotSessionsCommand,
  SessionSummary,
} from "@agentdesk/agent-feed-wire";
import { BOT_STORE_VERSION, type BotStore, type StoredBotSnapshot } from "./botStore.ts";

export type BotActor =
  | { kind: "user" }
  | { kind: "agent"; session: BotSessionRef };

export interface ResolvedBotSession {
  projectPath: string;
  summary: SessionSummary;
}

export interface BotRegistryCatalog {
  resolveProject(path: string): { projectPath: string } | undefined;
  resolveSession(ref: BotSessionRef): ResolvedBotSession | undefined;
  subscribe(listener: () => void): () => void;
}

export class BotInvalidError extends Error {}
export class BotNotFoundError extends Error {}
export class BotConflictError extends Error {}
export class BotForbiddenError extends Error {}

const MAX_NAME = 64;
const MAX_DIRECTORY_PATH = 4_096;
const MAX_ROLE = 120;
const MAX_DESCRIPTION = 1_000;
const MAX_LABELS = 12;
const MAX_LABEL = 32;
const MAX_CUSTOM_ENTRIES = 16;
const MAX_CUSTOM_KEY = 64;
const MAX_CUSTOM_VALUE = 256;
const MAX_ICON_URL = 2_048;
const MAX_SESSION_REFS_PER_COMMAND = 64;
const MAX_IDEMPOTENCY_ENTRIES = 512;
const EXTERNAL_STORE_POLL_MS = 1_000;

interface NormalizedAddBot {
  requestId: string;
  name: string;
  normalizedName: string;
  iconUrl?: string;
  directoryPath: string;
  metadata: BotMetadata;
  grants: BotGrant[];
}

interface NormalizedSessionRefCommand {
  requestId: string;
  sessionRefs: BotSessionRef[];
}

function compactOptional(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new BotInvalidError(`${name} must be a string`);
  const compact = value.trim();
  if (compact === "") return undefined;
  if (compact.length > maximum) throw new BotInvalidError(`${name} must be at most ${maximum} characters`);
  return compact;
}

function normalizeRequestId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new BotInvalidError("requestId is required and must be a bounded identifier");
  }
  return value;
}

function normalizeName(value: unknown): { name: string; normalizedName: string } {
  const name = compactOptional(value, "name", MAX_NAME);
  if (!name) throw new BotInvalidError("name is required");
  return { name, normalizedName: name.normalize("NFKC").toLocaleLowerCase("en-US") };
}

function normalizeIconUrl(value: unknown): string | undefined {
  const raw = compactOptional(value, "iconUrl", MAX_ICON_URL);
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new BotInvalidError("iconUrl must be a valid https URL", { cause: error });
  }
  if (url.protocol !== "https:") throw new BotInvalidError("iconUrl must use https");
  return url.toString();
}

function normalizeLabels(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LABELS) {
    throw new BotInvalidError(`metadata.labels must contain at most ${MAX_LABELS} strings`);
  }
  const labels = value.map((entry) => compactOptional(entry, "metadata label", MAX_LABEL));
  if (labels.some((entry) => entry === undefined)) {
    throw new BotInvalidError("metadata labels cannot be empty");
  }
  return [...new Set(labels as string[])];
}

function normalizeCustom(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BotInvalidError("metadata.custom must be an object of string values");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_CUSTOM_ENTRIES) {
    throw new BotInvalidError(`metadata.custom must contain at most ${MAX_CUSTOM_ENTRIES} entries`);
  }
  const normalized: Record<string, string> = {};
  for (const [key, raw] of entries) {
    const normalizedKey = compactOptional(key, "metadata key", MAX_CUSTOM_KEY);
    const normalizedValue = compactOptional(raw, `metadata.${key}`, MAX_CUSTOM_VALUE);
    if (!normalizedKey || !normalizedValue) {
      throw new BotInvalidError("metadata custom keys and values cannot be empty");
    }
    normalized[normalizedKey] = normalizedValue;
  }
  return normalized;
}

function normalizeGrants(value: unknown): BotGrant[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((grant) => grant !== "add_bot")) {
    throw new BotInvalidError('grants may contain only "add_bot"');
  }
  return value.includes("add_bot") ? ["add_bot"] : [];
}

function normalizeSessionRef(value: unknown): BotSessionRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BotInvalidError("sessionRefs must contain source-qualified session references");
  }
  const ref = value as Partial<BotSessionRef>;
  if (
    (ref.source !== "claude" && ref.source !== "codex" && ref.source !== "pi")
    || typeof ref.sessionId !== "string"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(ref.sessionId)
  ) {
    throw new BotInvalidError("sessionRefs must name an existing source and sessionId");
  }
  return { source: ref.source, sessionId: ref.sessionId };
}

function normalizeAddBot(command: AddBotCommand): NormalizedAddBot {
  const { name, normalizedName } = normalizeName(command.name);
  const directoryPath = compactOptional(command.directoryPath, "directoryPath", MAX_DIRECTORY_PATH);
  if (!directoryPath?.startsWith("/")) {
    throw new BotInvalidError("directoryPath must be an absolute existing AgentDesk project path");
  }
  return {
    requestId: normalizeRequestId(command.requestId),
    name,
    normalizedName,
    iconUrl: normalizeIconUrl(command.iconUrl),
    directoryPath,
    metadata: {
      role: compactOptional(command.metadata?.role, "metadata.role", MAX_ROLE),
      description: compactOptional(command.metadata?.description, "metadata.description", MAX_DESCRIPTION),
      labels: normalizeLabels(command.metadata?.labels),
      custom: normalizeCustom(command.metadata?.custom),
    },
    grants: normalizeGrants(command.grants),
  };
}

function normalizeSessionRefCommand(
  command: AttachBotSessionsCommand | DetachBotSessionsCommand,
): NormalizedSessionRefCommand {
  if (!Array.isArray(command.sessionRefs) || command.sessionRefs.length === 0) {
    throw new BotInvalidError("sessionRefs must contain at least one session");
  }
  if (command.sessionRefs.length > MAX_SESSION_REFS_PER_COMMAND) {
    throw new BotInvalidError(`sessionRefs may contain at most ${MAX_SESSION_REFS_PER_COMMAND} sessions`);
  }
  const sessionRefs = command.sessionRefs.map(normalizeSessionRef);
  if (new Set(sessionRefs.map(sessionKey)).size !== sessionRefs.length) {
    throw new BotInvalidError("sessionRefs cannot contain duplicates");
  }
  return { requestId: normalizeRequestId(command.requestId), sessionRefs };
}

function sessionKey(ref: BotSessionRef): string {
  return `${ref.source}:${ref.sessionId}`;
}

function actorKey(actor: BotActor): string {
  return actor.kind === "user" ? "user" : `agent:${sessionKey(actor.session)}`;
}

function commandSignature(value: unknown): string {
  return JSON.stringify(value);
}

function appendIdempotency(
  snapshot: StoredBotSnapshot,
  key: string,
  signature: string,
  botId: string,
): StoredBotSnapshot["idempotency"] {
  const idempotency = { ...snapshot.idempotency, [key]: { signature, botId } };
  while (Object.keys(idempotency).length > MAX_IDEMPOTENCY_ENTRIES) {
    const oldest = Object.keys(idempotency)[0];
    if (!oldest) break;
    delete idempotency[oldest];
  }
  return idempotency;
}

function priorBot(
  snapshot: StoredBotSnapshot,
  idempotencyKey: string,
  signature: string,
): BotRecord | undefined {
  const prior = snapshot.idempotency[idempotencyKey];
  if (!prior) return undefined;
  if (prior.signature !== signature) {
    throw new BotConflictError("requestId was reused with different Bot data");
  }
  const existing = snapshot.bots.find((bot) => bot.botId === prior.botId);
  if (!existing) throw new Error(`bots.json idempotency record references missing Bot ${prior.botId}`);
  return existing;
}

async function directoryAvailability(path: string): Promise<"available" | "missing"> {
  try {
    return (await stat(path)).isDirectory() ? "available" : "missing";
  } catch {
    return "missing";
  }
}

export class BotRegistry {
  constructor(
    private readonly store: BotStore,
    private readonly catalog: BotRegistryCatalog,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  async snapshot(): Promise<BotSnapshot> {
    return this.view(await this.store.snapshot());
  }

  async add(command: AddBotCommand, actor: BotActor): Promise<BotView> {
    const normalized = normalizeAddBot(command);
    const project = this.catalog.resolveProject(normalized.directoryPath);
    if (!project) throw new BotNotFoundError("selected directory is not in the current AgentDesk project catalog");
    const signature = commandSignature(normalized);
    const idempotencyKey = `add:${actorKey(actor)}:${normalized.requestId}`;

    const record = await this.store.mutate((snapshot) => {
      const prior = priorBot(snapshot, idempotencyKey, signature);
      if (prior) return { snapshot, value: prior };

      let createdBy: BotCreatedBy = { kind: "user" };
      if (actor.kind === "agent") {
        const caller = snapshot.bots.find((bot) =>
          bot.sessionRefs.some((ref) => sessionKey(ref) === sessionKey(actor.session))
        );
        if (!caller?.grants.includes("add_bot")) {
          throw new BotForbiddenError("invoking session is not attached to a Bot permitted to add Bots");
        }
        if (normalized.grants.length > 0) {
          throw new BotForbiddenError("an agent-created Bot cannot receive management grants");
        }
        createdBy = { kind: "bot", botId: caller.botId };
      }

      if (snapshot.bots.some((bot) => bot.name.normalize("NFKC").toLocaleLowerCase("en-US") === normalized.normalizedName)) {
        throw new BotConflictError(`a Bot named "${normalized.name}" already exists`);
      }
      if (snapshot.bots.some((bot) => bot.environment.path === project.projectPath)) {
        throw new BotConflictError(`project directory "${project.projectPath}" is already bound to a Bot`);
      }

      const bot: BotRecord = {
        botId: this.newId(),
        name: normalized.name,
        ...(normalized.iconUrl ? { iconUrl: normalized.iconUrl } : {}),
        environment: { kind: "directory", path: project.projectPath },
        sessionRefs: [],
        metadata: normalized.metadata,
        grants: normalized.grants,
        createdAt: this.now(),
        createdBy,
      };
      const next: StoredBotSnapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        bots: [...snapshot.bots, bot],
        idempotency: appendIdempotency(snapshot, idempotencyKey, signature, bot.botId),
      };
      return { snapshot: next, value: bot };
    });
    return this.viewRecord(record);
  }

  async attachSessions(
    botId: string,
    command: AttachBotSessionsCommand,
    actor: BotActor,
  ): Promise<BotView> {
    if (actor.kind !== "user") {
      throw new BotForbiddenError("only the authenticated user may attach sessions to a Bot");
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(botId)) throw new BotInvalidError("botId is invalid");
    const normalized = normalizeSessionRefCommand(command);
    const resolved = normalized.sessionRefs.map((ref) => {
      const session = this.catalog.resolveSession(ref);
      if (!session) throw new BotNotFoundError(`session ${sessionKey(ref)} is not in the current catalog`);
      return session;
    });
    const signature = commandSignature({ botId, ...normalized });
    const idempotencyKey = `attach:${actorKey(actor)}:${normalized.requestId}`;

    const record = await this.store.mutate((snapshot) => {
      const prior = priorBot(snapshot, idempotencyKey, signature);
      if (prior) return { snapshot, value: prior };
      const index = snapshot.bots.findIndex((bot) => bot.botId === botId);
      if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
      const bot = snapshot.bots[index]!;
      const outside = resolved.find((session) => session.projectPath !== bot.environment.path);
      if (outside) {
        throw new BotConflictError("every attached session must belong to the Bot's directory");
      }
      const attached = new Set(bot.sessionRefs.map(sessionKey));
      const duplicate = normalized.sessionRefs.find((ref) => attached.has(sessionKey(ref)));
      if (duplicate) throw new BotConflictError(`session ${sessionKey(duplicate)} is already attached to this Bot`);

      const updated: BotRecord = {
        ...bot,
        sessionRefs: [...bot.sessionRefs, ...normalized.sessionRefs],
      };
      const bots = [...snapshot.bots];
      bots[index] = updated;
      const next: StoredBotSnapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        bots,
        idempotency: appendIdempotency(snapshot, idempotencyKey, signature, bot.botId),
      };
      return { snapshot: next, value: updated };
    });
    return this.viewRecord(record);
  }

  async detachSessions(
    botId: string,
    command: DetachBotSessionsCommand,
    actor: BotActor,
  ): Promise<BotView> {
    if (actor.kind !== "user") {
      throw new BotForbiddenError("only the authenticated user may detach sessions from a Bot");
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(botId)) throw new BotInvalidError("botId is invalid");
    // Deliberately no catalog resolution: see `DetachBotSessionsCommand`. What has to be true is
    // that the Bot currently holds the reference, which the mutation below checks against the
    // stored record -- the one authority on what this Bot claims.
    const normalized = normalizeSessionRefCommand(command);
    const signature = commandSignature({ botId, ...normalized });
    const idempotencyKey = `detach:${actorKey(actor)}:${normalized.requestId}`;

    const record = await this.store.mutate((snapshot) => {
      const prior = priorBot(snapshot, idempotencyKey, signature);
      if (prior) return { snapshot, value: prior };
      const index = snapshot.bots.findIndex((bot) => bot.botId === botId);
      if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
      const bot = snapshot.bots[index]!;
      const attached = new Set(bot.sessionRefs.map(sessionKey));
      const absent = normalized.sessionRefs.find((ref) => !attached.has(sessionKey(ref)));
      if (absent) {
        throw new BotNotFoundError(`session ${sessionKey(absent)} is not attached to this Bot`);
      }

      const removing = new Set(normalized.sessionRefs.map(sessionKey));
      const updated: BotRecord = {
        ...bot,
        sessionRefs: bot.sessionRefs.filter((ref) => !removing.has(sessionKey(ref))),
      };
      const bots = [...snapshot.bots];
      bots[index] = updated;
      const next: StoredBotSnapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        bots,
        idempotency: appendIdempotency(snapshot, idempotencyKey, signature, bot.botId),
      };
      return { snapshot: next, value: updated };
    });
    return this.viewRecord(record);
  }

  async botAllowedToAdd(session: BotSessionRef): Promise<boolean> {
    const snapshot = await this.store.snapshot();
    return snapshot.bots.some((bot) =>
      bot.grants.includes("add_bot")
      && bot.sessionRefs.some((ref) => sessionKey(ref) === sessionKey(session))
    );
  }

  async subscribe(
    listener: (snapshot: BotSnapshot) => void,
    onError?: (error: unknown) => void,
  ): Promise<() => void> {
    let closed = false;
    let tail: Promise<void> = Promise.resolve();
    let lastRevision = -1;
    const emit = (force = true): void => {
      tail = tail.then(async () => {
        const snapshot = await this.snapshot();
        if (closed || (!force && snapshot.revision === lastRevision)) return;
        lastRevision = snapshot.revision;
        listener(snapshot);
      }).catch((error) => {
        if (!closed) onError?.(error);
      });
    };
    const stopStore = this.store.subscribe(() => emit());
    const stopCatalog = this.catalog.subscribe(() => emit());
    try {
      const initial = await this.snapshot();
      lastRevision = initial.revision;
      listener(initial);
    } catch (error) {
      stopStore();
      stopCatalog();
      throw error;
    }
    const poll = setInterval(() => emit(false), EXTERNAL_STORE_POLL_MS);
    poll.unref?.();
    return () => {
      closed = true;
      clearInterval(poll);
      stopStore();
      stopCatalog();
    };
  }

  private async view(snapshot: StoredBotSnapshot): Promise<BotSnapshot> {
    return {
      version: BOT_STORE_VERSION,
      revision: snapshot.revision,
      bots: await Promise.all(snapshot.bots.map((record) => this.viewRecord(record))),
    };
  }

  private async viewRecord(record: BotRecord): Promise<BotView> {
    const sessions: SessionSummary[] = [];
    const missingSessionRefs: BotSessionRef[] = [];
    for (const ref of record.sessionRefs) {
      const resolved = this.catalog.resolveSession(ref);
      if (resolved && resolved.projectPath === record.environment.path) sessions.push(resolved.summary);
      else missingSessionRefs.push(ref);
    }
    return {
      ...record,
      environmentAvailability: await directoryAvailability(record.environment.path),
      sessions,
      missingSessionRefs,
    };
  }
}
