import { stat } from "node:fs/promises";
import type {
  AddBotCommand,
  AddBotSessionsCommand,
  BotCreatedBy,
  BotMetadata,
  BotRecord,
  BotSessionRef,
  BotSessionsAdded,
  BotSnapshot,
  BotView,
  StartedBotSession,
  DetachBotSessionsCommand,
  SessionSummary,
} from "@agentdesk/agent-feed-wire";
import { startClaudeSession, startForkedClaudeSession } from "@/terminal/claudeSessionLaunch";
import { directoryBelongsTo, worktreeOf } from "@/git/worktree";
import { BOT_STORE_VERSION, type BotStore, type StoredBotSnapshot } from "@/bots/botStore";
import {
  normalizeAddBot,
  normalizeLaunchFor,
  normalizeSessionRef,
  normalizeSessionRefCommand,
  type NormalizedLaunch,
} from "@/bots/botCommands";
import { actorKey, appendIdempotency, commandSignature, priorBot, sessionKey } from "@/bots/botIdempotency";
import { BotSessionStarter } from "@/bots/botSessionLaunch";
import {
  BotConflictError,
  BotForbiddenError,
  BotInvalidError,
  BotLaunchError,
  BotNotFoundError,
  type BotActor,
  type BotRegistryCatalog,
  type BotSessionLauncher,
  type ResolvedBotSession,
} from "@/bots/botTypes";

// Re-exported because callers reach for the registry's vocabulary through the registry.
// The declarations live in `botTypes.ts`.
export {
  BotConflictError,
  BotForbiddenError,
  BotInvalidError,
  BotLaunchError,
  BotNotFoundError,
  type BotActor,
  type BotRegistryCatalog,
  type BotSessionLauncher,
  type ResolvedBotSession,
};

async function directoryAvailability(path: string): Promise<"available" | "missing"> {
  try {
    return (await stat(path)).isDirectory() ? "available" : "missing";
  } catch {
    return "missing";
  }
}

export class BotRegistry {
  /** Bringing a session into existence, which is its own act. See `botSessionLaunch.ts`. */
  private readonly starter: BotSessionStarter;

  constructor(
    private readonly store: BotStore,
    private readonly catalog: BotRegistryCatalog,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly launcher: BotSessionLauncher = {
      start: startClaudeSession,
      fork: startForkedClaudeSession,
    },
    /**
     * Separate from `newId`, and it must produce a real UUID.
     *
     * The Bot id is opaque and anything unique will do; this one is handed to `--session-id`,
     * names the transcript file, and derives the pane the Bot's terminal later joins. Sharing the
     * generator would let a test's readable stand-in reach a place that needs the real shape.
     */
    private readonly newSessionId: () => string = () => crypto.randomUUID(),
  ) {
    this.starter = new BotSessionStarter(store, catalog, launcher, newSessionId);
  }

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
  async add(command: AddBotCommand, actor: BotActor): Promise<BotSessionsAdded> {
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

    if (!normalized.launch) return { bot: await this.viewRecord(created.bot) };
    // A replay normally starts nothing -- idempotency that spawned an agent per retry would be
    // worse than none. The exception is a replay of a command whose launch FAILED: the Bot is
    // there and holds no sessions, so starting one finishes the original command rather than
    // repeating it, and resending the identical request is the obvious move once the cause is
    // fixed.
    if (!created.fresh && created.bot.sessionRefs.length > 0) {
      return { bot: await this.viewRecord(created.bot) };
    }

    // Everything after this point has already written a Bot, so every failure here is a
    // `BotLaunchError`: the caller cannot simply retry a different command, and the message has to
    // say what survived.
    const started = await this.starter.launchOrExplain(created.bot, normalized.launch);
    return {
      bot: await this.viewRecord(
        await this.starter.recordStartedSession(created.bot.botId, { source: "claude", sessionId: started.sessionId }),
      ),
      started,
    };
  }

  /**
   * Adds sessions to a Bot: ones that already exist, one this call starts, or both.
   *
   * One method because they are one act -- put a session on this Bot -- and because the split is
   * what produced the shape this replaced, where starting a session meant asking a different
   * subsystem for a terminal and letting the creation happen as a side effect.
   *
   * The references are attached first and the launch runs after. A launch that forks names one of
   * the Bot's own sessions, so a command that attaches a session and then forks it in the same
   * breath has to see its own attach.
   */
  async addSessions(
    botId: string,
    command: AddBotSessionsCommand,
    actor: BotActor,
  ): Promise<BotSessionsAdded> {
    if (actor.kind !== "user") {
      throw new BotForbiddenError("only the authenticated user may add sessions to a Bot");
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(botId)) throw new BotInvalidError("botId is invalid");
    const normalized = normalizeSessionRefCommand(command, { optional: true });
    const launch = normalizeLaunchFor(botId, command.launch);
    if (normalized.sessionRefs.length === 0 && !launch) {
      throw new BotInvalidError("sessionRefs or launch is required");
    }
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
    const signature = commandSignature({ botId, ...normalized, launch });
    const idempotencyKey = `sessions:${actorKey(actor)}:${normalized.requestId}`;

    const record = await this.store.mutate((snapshot) => {
      const prior = priorBot(snapshot, idempotencyKey, signature);
      if (prior) return { snapshot, value: { bot: prior, fresh: false } };
      const index = snapshot.bots.findIndex((bot) => bot.botId === botId);
      if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
      const bot = snapshot.bots[index]!;
      if (normalized.sessionRefs.length === 0) {
        return {
          snapshot: {
            ...snapshot,
            revision: snapshot.revision + 1,
            idempotency: appendIdempotency(snapshot, idempotencyKey, signature, bot.botId),
          },
          value: { bot, fresh: true },
        };
      }
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
      return { snapshot: next, value: { bot: updated, fresh: true } };
    });

    if (!launch) return { bot: await this.viewRecord(record.bot) };
    // A replay attaches nothing and starts nothing. Unlike Bot creation there is no half-done
    // state to finish: the references landed or they did not, and a Bot that already holds them
    // is the answer to the same question being asked twice.
    if (!record.fresh) return { bot: await this.viewRecord(record.bot) };

    // Nothing durable has been spent on the launch itself yet, so its refusals stay ordinary
    // refusals -- a branch that exists, a source that is not this Bot's -- and the caller can fix
    // the command and send a different one.
    const started = await this.starter.launchSession(record.bot, launch);
    return {
      bot: await this.viewRecord(
        await this.starter.recordStartedSession(botId, { source: "claude", sessionId: started.sessionId }),
      ),
      started,
    };
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
