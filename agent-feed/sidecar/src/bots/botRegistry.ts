import { stat } from "node:fs/promises";
import type {
  AddBotCommand,
  AttachBotSessionsCommand,
  BotCreatedBy,
  BotGrant,
  BotLaunchCommand,
  BotMetadata,
  BotRecord,
  BotSessionRef,
  BotSnapshot,
  BotView,
  DetachBotSessionsCommand,
  SessionSummary,
} from "@agentdesk/agent-feed-wire";
import { sessionTitleRefusal } from "../transcripts/sessionTitle.ts";
import { startClaudeSession } from "../terminal/claudeSessionLaunch.ts";
import { directoryBelongsTo, worktreeOf } from "../git/worktree.ts";
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
/**
 * The Bot exists; its session does not.
 *
 * Its own class because it is the one failure here that leaves something behind. Every other
 * refusal happens before the record is written, so the caller can retry the identical command;
 * this one has already spent a name and a directory, and a retry would collide with the Bot it
 * just made. The message therefore names what to do with it rather than only what went wrong.
 */
export class BotLaunchError extends Error {}

/**
 * What actually starts a Bot's session, injected so the tests never spawn one.
 *
 * A seam rather than a direct call because the alternative is a test suite that either runs tmux
 * or does not exercise this path at all, and the second is how the ordering below stops being
 * checked.
 */
export interface BotSessionLauncher {
  start(options: {
    cwd: string;
    sessionId: string;
    title: string;
    prompt?: string;
  }): Promise<unknown>;
}

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
/**
 * How long a launch prompt may be.
 *
 * It becomes one argv element passed through two shells, where the ceiling is the kernel's
 * argument limit, about a megabyte -- so this is not that constraint. It is the size at which a
 * "first turn" has stopped being one: a grounding brief written by hand runs a few thousand
 * characters, and something ten times that belongs in a file the session reads for itself.
 */
const MAX_LAUNCH_PROMPT = 32_768;
const MAX_SESSION_REFS_PER_COMMAND = 64;
const MAX_IDEMPOTENCY_ENTRIES = 512;

interface NormalizedAddBot {
  requestId: string;
  name: string;
  normalizedName: string;
  iconUrl?: string;
  directoryPath: string;
  metadata: BotMetadata;
  grants: BotGrant[];
  launch?: NormalizedLaunch;
}

interface NormalizedLaunch {
  title: string;
  prompt?: string;
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

/**
 * The launch options, with the Bot's own name standing in for a title nobody gave.
 *
 * The title is validated by the same rule a rename obeys, because it is the same field: `-n`
 * writes it to the session registry, and a line break in it would split the argument rather than
 * the name. A Bot name is already bounded well inside that, so the default never refuses.
 */
function normalizeLaunch(value: unknown, botName: string): NormalizedLaunch | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BotInvalidError("launch must be an object");
  }
  const command = value as BotLaunchCommand;
  const title = compactOptional(command.title, "launch.title", MAX_NAME) ?? botName;
  const refusal = sessionTitleRefusal(title);
  if (refusal) throw new BotInvalidError(`launch.title: ${refusal}`);
  return {
    title,
    // Only trimmed, never reshaped: the prompt is the session's first turn and its line breaks
    // are the reader's.
    prompt: compactOptional(command.prompt, "launch.prompt", MAX_LAUNCH_PROMPT),
  };
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
    launch: normalizeLaunch(command.launch, name),
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
    private readonly launcher: BotSessionLauncher = { start: startClaudeSession },
    /**
     * Separate from `newId`, and it must produce a real UUID.
     *
     * The Bot id is opaque and anything unique will do; this one is handed to `--session-id`,
     * names the transcript file, and derives the pane the Bot's terminal later joins. Sharing the
     * generator would let a test's readable stand-in reach a place that needs the real shape.
     */
    private readonly newSessionId: () => string = () => crypto.randomUUID(),
  ) {}

  async snapshot(): Promise<BotSnapshot> {
    return this.view(await this.store.snapshot());
  }

  /**
   * Creates the Bot, and -- when asked -- starts the session that works in it.
   *
   * The order is deliberate and it is the whole design of this method. Creating first means the
   * likely failures (a name or a directory already taken) cost nothing but an error, where
   * launching first would spawn an agent into the user's repository and then have to hunt it down
   * again. The unlikely failure, an environment with no tmux or no `claude`, leaves a Bot with no
   * sessions: inert, visible, and one attach away from correct.
   *
   * A replayed `requestId` returns the Bot it made the first time and starts nothing. Idempotency
   * that spawned a second agent per retry would be worse than none.
   */
  async add(command: AddBotCommand, actor: BotActor): Promise<BotView> {
    const normalized = normalizeAddBot(command);
    const project = this.catalog.resolveProject(normalized.directoryPath);
    if (!project) throw new BotNotFoundError("selected directory is not in the current AgentDesk project catalog");
    if (normalized.launch && actor.kind !== "user") {
      // Adding a row and starting a process are different powers. `add_bot` grants the first; a
      // Bot that could also spawn agents would be granting itself the second.
      throw new BotForbiddenError("only the authenticated user may start a Bot's session");
    }
    const signature = commandSignature(normalized);
    const idempotencyKey = `add:${actorKey(actor)}:${normalized.requestId}`;

    const created = await this.store.mutate((snapshot) => {
      const prior = priorBot(snapshot, idempotencyKey, signature);
      if (prior) return { snapshot, value: { bot: prior, fresh: false } };

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
      return { snapshot: next, value: { bot, fresh: true } };
    });

    if (!normalized.launch) return this.viewRecord(created.bot);
    // A replay normally starts nothing -- idempotency that spawned an agent per retry would be
    // worse than none. The exception is a replay of a command whose launch FAILED: the Bot is
    // there and holds no sessions, so starting one finishes the original command rather than
    // repeating it, and resending the identical request is the obvious move once the cause is
    // fixed.
    if (!created.fresh && created.bot.sessionRefs.length > 0) return this.viewRecord(created.bot);

    const sessionId = this.newSessionId();
    try {
      await this.launcher.start({
        cwd: project.projectPath,
        sessionId,
        title: normalized.launch.title,
        prompt: normalized.launch.prompt,
      });
    } catch (error) {
      throw new BotLaunchError(
        `Bot "${created.bot.name}" was created, but its session could not be started. `
          + "Resend this request once the cause is fixed, or attach a session to "
          + `${created.bot.botId} by hand.`,
        { cause: error },
      );
    }
    return this.viewRecord(
      await this.recordStartedSession(created.bot.botId, { source: "claude", sessionId }),
    );
  }

  /**
   * Attaches a session this registry just started.
   *
   * Deliberately not `attachSessions`, which resolves every reference against the catalog and
   * refuses one it cannot find. That check is right for a reference a caller supplies -- it is the
   * only thing stopping a Bot claiming another directory's session -- and wrong here, because the
   * session was started seconds ago in the Bot's own directory and has not written a transcript
   * yet, so there is nothing for the catalog to have seen. The id is known-good by construction:
   * this method's caller generated it and passed it to `--session-id`.
   *
   * Until the first turn lands the reference sits in `missingSessionRefs`, which is the honest
   * reading of it, and moves to `sessions` on its own when the catalog picks the file up.
   */
  private async recordStartedSession(botId: string, ref: BotSessionRef): Promise<BotRecord> {
    return this.store.mutate((snapshot) => {
      const index = snapshot.bots.findIndex((bot) => bot.botId === botId);
      if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
      const bot = snapshot.bots[index]!;
      if (bot.sessionRefs.some((existing) => sessionKey(existing) === sessionKey(ref))) {
        return { snapshot, value: bot };
      }
      const updated: BotRecord = { ...bot, sessionRefs: [...bot.sessionRefs, ref] };
      const bots = [...snapshot.bots];
      bots[index] = updated;
      return {
        snapshot: { ...snapshot, revision: snapshot.revision + 1, bots },
        value: updated,
      };
    });
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
    // Asked out here because the mutation below is synchronous, and because it is a question about
    // the disk rather than about the snapshot: whether each session's directory is the Bot's
    // directory or a git worktree of it.
    //
    // Read against the Bot as it stands now, which the mutation then re-reads. A Bot cannot change
    // its directory, so the two readings cannot disagree about the thing this is asking; a Bot
    // that has been deleted in between fails inside the mutation with its own error, which is the
    // one worth reporting.
    const directory = (await this.store.snapshot()).bots
      .find((bot) => bot.botId === botId)?.environment.path;
    const belongs = new Map<string, boolean>();
    for (const path of new Set(resolved.map((session) => session.projectPath))) {
      belongs.set(path, directory ? await directoryBelongsTo(path, directory) : false);
    }
    const signature = commandSignature({ botId, ...normalized });
    const idempotencyKey = `attach:${actorKey(actor)}:${normalized.requestId}`;

    const record = await this.store.mutate((snapshot) => {
      const prior = priorBot(snapshot, idempotencyKey, signature);
      if (prior) return { snapshot, value: prior };
      const index = snapshot.bots.findIndex((bot) => bot.botId === botId);
      if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
      const bot = snapshot.bots[index]!;
      const outside = resolved.find((session) =>
        session.projectPath !== bot.environment.path && !belongs.get(session.projectPath)
      );
      if (outside) {
        throw new BotConflictError(
          "every attached session must belong to the Bot's directory, or a git worktree of it",
        );
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
    // No timer: the store watches its own file, so a change made by another process arrives as a
    // store event exactly like one made here. Both of these subscriptions are the whole signal.
    return () => {
      closed = true;
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

  /**
   * Says which worktree a session is working in, when it is not the Bot's own directory.
   *
   * Only for the rows that need it. A Bot's sessions are usually all in its directory, and a field
   * that is present and empty on every one of those is a field every reader has to learn to
   * ignore. Absent means the ordinary case: this session is in the checkout the Bot names.
   *
   * The branch rather than the path, because the path is what a reader already sees on the Bot and
   * the branch is what they do not. Two sessions on one repository editing two branches look
   * identical without it, which is the failure that made accepting them worth guarding.
   */
  private async withWorktree(
    summary: SessionSummary,
    projectPath: string,
    botPath: string,
  ): Promise<SessionSummary> {
    if (projectPath === botPath) return summary;
    const worktree = await worktreeOf(projectPath);
    if (!worktree) return summary;
    return { ...summary, worktree: { path: projectPath, branch: worktree.branch } };
  }

  private async viewRecord(record: BotRecord): Promise<BotView> {
    const sessions: SessionSummary[] = [];
    const missingSessionRefs: BotSessionRef[] = [];
    for (const ref of record.sessionRefs) {
      const resolved = this.catalog.resolveSession(ref);
      // The same predicate the attach used, and it has to be: a Bot that accepts a session and
      // then reports it missing would be worse than one that refused it, because the refusal at
      // least says so at the moment somebody can act on it.
      const inside = resolved
        && await directoryBelongsTo(resolved.projectPath, record.environment.path);
      if (resolved && inside) sessions.push(await this.withWorktree(resolved.summary, resolved.projectPath, record.environment.path));
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
