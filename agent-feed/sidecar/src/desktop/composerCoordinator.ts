import type {
  DesktopAuditSnapshot,
  WindowComposerEnvelope,
  WindowComposerStatus,
  WindowInputReason,
  WindowQuestionAction,
  WindowQuestionStatus,
  WindowTarget,
} from "@agentdesk/agent-feed-wire";
import { config } from "../config.ts";
import {
  desktopOwner,
  liveProcessRows,
  type ProcessRow,
  resolve,
  sessionOwner,
  target as targetWindow,
} from "./claudeSessionResolver.ts";
import {
  codexMainPids,
  type CodexWindowSummary,
  matchWindow,
  target as codexTarget,
  threadName,
  threadRecord,
} from "./codexSessionResolver.ts";
import { ControlHelperError, type ControlHelper, controlHelper } from "./controlHelper.ts";
import { createRendererReviver, type RendererReviver } from "./rendererReviver.ts";

/**
 * One writer for Claude Desktop's composers, shared by every Agents window and every paired phone.
 *
 * A module singleton rather than one per surface, because a write may move a Claude window between
 * Desktops: two coordinators could move the same window at once, and each would restore it to a home
 * Desktop the other had already changed. That was the reason the host kept exactly one, and it does
 * not change by moving here -- the process boundary is what makes it true, and there is one sidecar
 * per host.
 *
 * Everything in this file is policy: when to resolve, when a read is cheap enough to take, how long
 * to wait, what to do about a wedged renderer, and what a viewer is told. None of it is a native
 * capability, which is why it stopped costing an app build.
 */

// The status shapes live in `agent-feed/wire/desktopWindow.ts`, not here: they cross the HTTP
// boundary to the panel, and the wire module is the single declaration for everything that does.
export type ComposerStatus = WindowComposerStatus;
export type QuestionStatus = WindowQuestionStatus;
export type ComposerEnvelope = WindowComposerEnvelope;
export type QuestionAction = WindowQuestionAction;

/**
 * One line per composer event that moved a window or refused to.
 *
 * The Swift path this replaced logged every move-in, move-back, and unverified move to the host's
 * unified log; the port arrived with no diagnostics at all, so the first real failure had to be
 * diagnosed from a screenshot. Same `console.log(JSON.stringify(...))` shape as the catalog, which
 * means it lands in the host's `agent-feed-sidecar` category and greps beside everything else.
 *
 * Only failures and window movement. A per-poll line would bury them.
 */
function logComposer(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: `agent-feed-composer-${event}`, ...fields }));
}

/** A failure carrying a code the panel maps to a sentence. */
export class ComposerError extends Error {
  constructor(readonly reason: WindowInputReason) {
    super(`composer request failed: ${reason}`);
    this.name = "ComposerError";
  }
}

/**
 * Which application owns a session's window.
 *
 * Carried alongside the id rather than inferred, because the two resolvers answer different
 * questions: Claude's is the process tree, Codex's is the app's own state joined to its accessibility
 * tree. Nothing downstream guesses which one to run.
 */
export type WindowSource = "claude" | "codex";

/** A session, and the application whose window shows it. */
export interface SessionKey {
  source: WindowSource;
  sessionId: string;
}

function keyOf(key: SessionKey): string {
  return `${key.source}:${key.sessionId}`;
}

interface Subscription {
  source: WindowSource;
  sessionId: string;
  emit: (envelope: ComposerEnvelope) => void;
  lastComposer: ComposerStatus | null;
  lastQuestion: QuestionStatus | null;
}

export interface ComposerCoordinatorOptions {
  helper?: ControlHelper;
  reviver?: RendererReviver;
  processRows?: () => Promise<ProcessRow[]>;
  pollIntervalMs?: number;
  now?: () => number;
}

export function createComposerCoordinator(options: ComposerCoordinatorOptions = {}) {
  const helper = options.helper ?? controlHelper;
  const reviver = options.reviver ?? createRendererReviver();
  const processRows = options.processRows ?? liveProcessRows;
  const pollIntervalMs = options.pollIntervalMs ?? config.claudeWindowResolveIntervalMs;
  const now = options.now ?? (() => Date.now());

  const subscriptions = new Set<Subscription>();
  /** Windows borrowed onto this Desktop for a focused watcher, keyed by session. */
  const editingLeases = new Map<string, WindowTarget>();
  /** Why a lease could not be taken. Reported instead of a target until the watcher goes away. */
  const editingLeaseFailures = new Map<string, WindowInputReason>();
  /** Last resolved target per session, so a transient failure does not wipe a live field. */
  const lastTargets = new Map<string, WindowTarget>();
  /** Pids with a live AX observer. While observed, the poll skips value reads. */
  const observed = new Set<number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Serializes every window-moving operation. See the file header. */
  let queue: Promise<unknown> = Promise.resolve();

  helper.onPush((event) => {
    if (event.type !== "composer-changed") return;
    const pid = typeof event.pid === "number" ? event.pid : null;
    if (pid === null) return;
    // The helper reports the PROCESS; which sessions that is depends on resolution, which lives
    // here. Refreshing only the sessions on that pid keeps an unrelated instance's typing from
    // costing every watcher an AX read.
    void refresh({ onlyPid: pid });
  });

  // MARK: - Resolution

  async function auditSnapshot(): Promise<DesktopAuditSnapshot> {
    return await helper.request("desktop-audit") as unknown as DesktopAuditSnapshot;
  }

  /**
   * The window for a session, or the reason there is not one.
   *
   * Two sources, in order: the argv resolver, then the per-pid registry for a brand-new session
   * whose id was never written into any argv. A lease failure short-circuits both -- the window is
   * stranded and re-resolving would report a target the writer cannot use.
   */
  async function resolveTarget(
    key: SessionKey,
    rows: ProcessRow[],
    snapshot: DesktopAuditSnapshot,
  ): Promise<WindowTarget | { reason: WindowInputReason }> {
    const leaseFailure = editingLeaseFailures.get(keyOf(key));
    if (leaseFailure) return { reason: leaseFailure };
    return key.source === "codex"
      ? await resolveCodexTarget(key.sessionId, rows, snapshot)
      : resolveClaudeTarget(key.sessionId, rows, snapshot);
  }

  function resolveClaudeTarget(
    sessionId: string,
    rows: ProcessRow[],
    snapshot: DesktopAuditSnapshot,
  ): WindowTarget | { reason: WindowInputReason } {
    const owner = sessionOwner(resolve(sessionId, rows));
    const pid = typeof owner === "number" ? owner : desktopOwner(sessionId, rows);
    if (pid === null) return typeof owner === "number" ? { reason: "no-window" } : owner;
    const resolved = targetWindow(sessionId, pid, snapshot);
    return resolved.ok ? resolved.target : { reason: resolved.reason };
  }

  /**
   * The Codex window showing a thread.
   *
   * Three joins, none of which the process tree can do: the app's registry gives the thread its `cwd`
   * and lowercased title, the JSONL index gives the title the app actually SHOWS, and the helper's
   * window summaries give each window's header or Recents identity. Exactly one match is a window;
   * more than one is refused, because a write into the wrong conversation looks successful until the
   * text appears there.
   */
  async function resolveCodexTarget(
    sessionId: string,
    rows: ProcessRow[],
    snapshot: DesktopAuditSnapshot,
  ): Promise<WindowTarget | { reason: WindowInputReason }> {
    const pids = codexMainPids(rows);
    if (pids.length === 0) return { reason: "not-running" };
    if (pids.length > 1) return { reason: "multiple-instances" };
    const mainPid = pids[0]!;

    const record = await threadRecord(sessionId);
    if (!record) return { reason: "no-window" };

    const answer = await call("codex-window-summaries", { mainPid });
    const windows = (answer.windows ?? []) as CodexWindowSummary[];
    const match = matchWindow(record.title, record.cwd, threadName(sessionId), windows);
    if (match.kind === "ambiguous") return { reason: "ambiguous-window" };
    if (match.kind === "not-found") return { reason: "no-window" };
    return codexTarget(sessionId, mainPid, match.window.windowID, snapshot);
  }

  /**
   * Takes AX handles on every Codex window while they are reachable.
   *
   * Codex Desktop will not list windows on other Spaces, so a thread living in one cannot be resolved
   * until a handle has been taken for it, and taking one means the window must be here. Doing this
   * when a thread is SELECTED rather than on the poll is what keeps that to once per window.
   */
  async function captureCodexWindows(rows: ProcessRow[]): Promise<void> {
    const pids = codexMainPids(rows);
    if (pids.length !== 1) return;
    await call("codex-capture-windows", { mainPid: pids[0]! }).catch(() => {});
  }

  // MARK: - Window borrowing

  /**
   * Runs `body` with the window on this Desktop, and puts it back.
   *
   * The restore happens BEFORE the result is judged. A window left on the wrong Desktop is a visible
   * change to the user's workspace, so restoring it outranks reporting the write, and a failure to
   * restore outranks a failed write in what the panel should say.
   *
   * `allowsActivation` marks the submit path. Pressing Return deliberately fronts the window, so the
   * frontmost change is the requested outcome there rather than the broken assumption it is
   * everywhere else.
   */
  async function withWindowHere<T>(
    source: WindowSource,
    target: WindowTarget,
    allowsActivation: boolean,
    body: () => Promise<T>,
  ): Promise<T> {
    const frontmostBefore = await frontmostPid();
    // Claude only: Codex exposes no `AXManualAccessibility` attribute, and setting it on that app
    // fails rather than being a harmless no-op.
    if (source === "claude") await call("ax-latch", { claudeMainPid: target.claudeMainPid });

    let moved = false;
    if (!target.onActiveDesktop) {
      await moveWindow(target.windowID, target.activeSpaceID, "move-in");
      moved = true;
      // Chromium builds the tree lazily and only for the current Space, so the composer is absent
      // for a moment after the move and the first search reliably misses it.
      await awaitComposer(source, target);
    }

    let outcome: T;
    let failure: unknown;
    try {
      outcome = await body();
    } catch (error) {
      failure = error;
      outcome = undefined as T;
    }

    if (moved) await restoreWindow(target);

    if (failure !== undefined) throw failure;

    // Sampled after the restore so the whole sequence is covered. Nothing above activates an
    // application, so a change means an assumption broke; it cannot be undone, only reported.
    if (!allowsActivation && frontmostBefore !== null && await frontmostPid() !== frontmostBefore) {
      throw new ComposerError("focus-stolen");
    }
    return outcome;
  }

  async function frontmostPid(): Promise<number | null> {
    const answer = await call("frontmost-pid", {});
    return typeof answer.pid === "number" ? answer.pid : null;
  }

  /**
   * Moves a window between Desktops, carrying the verify budget.
   *
   * The helper dispatches the bridged operation and then re-reads Space membership to decide whether
   * it took; WindowServer converges a moment later, so how long to keep re-reading is timing policy
   * and belongs here rather than compiled into the helper.
   */
  async function moveWindow(windowID: number, spaceID: string, leg: string): Promise<void> {
    try {
      await call("window-move", {
        windowID,
        spaceID,
        verifyAttempts: config.claudeWindowMoveVerifyAttempts,
        verifyIntervalMs: config.claudeWindowMoveVerifyIntervalMs,
      });
    } catch (error) {
      logComposer("window-move-failed", {
        windowID,
        spaceID,
        leg,
        reason: error instanceof ComposerError ? error.reason : String(error),
      });
      throw error;
    }
  }

  /**
   * Sends a borrowed window back, retrying once before giving up.
   *
   * The retry is not superstition: the move-in that preceded it has already proven the mover works
   * for this window, so a failure here is a convergence miss rather than a capability problem, and a
   * second attempt is far cheaper than what failing costs -- a window abandoned on the Desktop the
   * user is looking at.
   *
   * A failure is reported as `restore-failed`, never `move-failed`. The two are opposite states and
   * the panel's sentence for each has to name which one the user is in.
   */
  async function restoreWindow(target: WindowTarget): Promise<void> {
    for (const leg of ["restore", "restore-retry"] as const) {
      try {
        await moveWindow(target.windowID, target.homeSpaceID, leg);
        return;
      } catch (error) {
        // A capability that is not there does not arrive on the second try.
        if (error instanceof ComposerError && error.reason === "window-mover-unavailable") throw error;
      }
    }
    throw new ComposerError("restore-failed");
  }

  /**
   * The verb for one intent, per source.
   *
   * Claude addresses a window by pid plus frame (Accessibility exposes no window id for it), Codex by
   * WindowServer id. Same intent, different call, and this is the one place that knows.
   */
  function verb(source: WindowSource, intent: "read" | "write" | "submit" | "await"): string {
    return source === "codex" ? `codex-composer-${intent}` : `composer-${intent}`;
  }

  function payloadFor(source: WindowSource, target: WindowTarget): Record<string, unknown> {
    return source === "codex"
      ? { windowID: target.windowID, mainPid: target.claudeMainPid }
      : targetPayload(target);
  }

  /** Waits for a moved window to build its tree, with the budget this source needs. */
  async function awaitComposer(source: WindowSource, target: WindowTarget): Promise<void> {
    await call(verb(source, "await"), {
      ...payloadFor(source, target),
      timeoutMs: source === "codex"
        ? config.codexTreeMaterializeTimeoutMs
        : config.claudeComposerMaterializeTimeoutMs,
      pollMs: config.claudeComposerMaterializePollMs,
    });
  }

  function targetPayload(target: WindowTarget) {
    return {
      claudeMainPid: target.claudeMainPid,
      windowID: target.windowID,
      bounds: target.bounds,
    };
  }

  /** One helper verb, with `ControlHelperError` mapped to a reason the panel can render. */
  async function call(verb: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await helper.request(verb, payload);
    } catch (error) {
      if (error instanceof ControlHelperError) {
        throw new ComposerError(asReason(error.reason));
      }
      throw error;
    }
  }

  /**
   * A helper reason string as a wire code.
   *
   * The helper only ever emits codes from the same union, but it is a separate process built from a
   * separate file, so an unknown string degrades to `helper-unavailable` rather than being trusted
   * into the type.
   */
  function asReason(reason: string): WindowInputReason {
    return KNOWN_REASONS.has(reason) ? reason as WindowInputReason : "helper-unavailable";
  }

  // MARK: - Editing lease

  function isWatched(key: SessionKey): boolean {
    for (const subscription of subscriptions) {
      if (subscription.sessionId === key.sessionId && subscription.source === key.source) return true;
    }
    return false;
  }

  /**
   * Borrows a session's window onto this Desktop for as long as a surface is watching it.
   *
   * Only for windows not already here. A window already on this Desktop needs neither ownership nor
   * restoration, and taking a lease on it would be a move-out and move-back for nothing.
   */
  async function beginEditingLease(key: SessionKey): Promise<void> {
    const id = keyOf(key);
    editingLeaseFailures.delete(id);
    if (editingLeases.has(id)) return;

    const rows = await processRows();
    // Codex will not list windows on other Spaces, so selecting a thread is the one moment a sweep is
    // allowed: it is what makes an off-Desktop Codex window addressable at all.
    if (key.source === "codex") await captureCodexWindows(rows);
    const resolved = await resolveTarget(key, rows, await auditSnapshot());
    if ("reason" in resolved || resolved.onActiveDesktop) return;

    try {
      // Source-aware for the same reason `withWindowHere` is: Codex exposes no `AXManualAccessibility`
      // attribute and its composer answers different verbs. Latching and awaiting as though every
      // session were a Claude one made the borrow fail on the app it was borrowing for.
      if (key.source === "claude") {
        await call("ax-latch", { claudeMainPid: resolved.claudeMainPid });
      }
      await moveWindow(resolved.windowID, resolved.activeSpaceID, "lease-in");
      try {
        await awaitComposer(key.source, resolved);
      } catch (error) {
        // The borrow failed after the window was already moved. Put it back before reporting, or the
        // user is left with a window on the wrong Desktop and an error that does not mention it.
        await restoreWindow(resolved).catch(() => {});
        throw error;
      }
      editingLeases.set(id, resolved);
    } catch (error) {
      // `move-failed` is the default only because a borrow is a move; anything the helper actually
      // named wins over it.
      const reason = error instanceof ComposerError ? error.reason : "move-failed";
      logComposer("lease-failed", { session: id, reason });
      editingLeaseFailures.set(id, reason);
    }
  }

  /**
   * Returns a borrowed window once every surface has stopped watching.
   *
   * A failed restore keeps the lease recorded so a later unwatch can retry, rather than forgetting a
   * visibly stranded window.
   */
  async function endEditingLease(key: SessionKey): Promise<void> {
    if (isWatched(key)) return;
    const id = keyOf(key);
    editingLeaseFailures.delete(id);
    const target = editingLeases.get(id);
    if (!target) return;
    try {
      await restoreWindow(target);
      editingLeases.delete(id);
      lastTargets.delete(id);
    } catch (error) {
      // Kept, so the next unwatch or a later detach retries. Logged because nothing else will say
      // it: there is no subscriber left to emit a status to, and the only other evidence is a window
      // sitting on the wrong Desktop.
      logComposer("lease-restore-failed", {
        session: id,
        windowID: target.windowID,
        homeSpaceID: target.homeSpaceID,
        reason: error instanceof ComposerError ? error.reason : String(error),
      });
    }
  }

  // MARK: - Polling

  function startPolling() {
    if (timer !== null) return;
    timer = setInterval(() => void refresh({}), pollIntervalMs);
  }

  function stopPollingIfIdle() {
    if (subscriptions.size > 0 || timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  /**
   * Re-resolves every watched session and emits only what changed.
   *
   * Each DISTINCT session is resolved once per pass even when several surfaces watch it, because the
   * expensive part is the Accessibility round trip and both surfaces get the same answer.
   */
  async function refresh({ onlyPid, force }: { onlyPid?: number; force?: Subscription } = {}) {
    if (subscriptions.size === 0) return;
    let rows: ProcessRow[];
    let snapshot: DesktopAuditSnapshot;
    try {
      rows = await processRows();
      snapshot = await auditSnapshot();
    } catch (error) {
      // The helper is gone or untrusted. Every watcher hears the same thing rather than a silently
      // frozen field.
      const reason = error instanceof ComposerError ? error.reason : "helper-unavailable";
      for (const subscription of subscriptions) {
        emitComposer(subscription, {
          sessionId: subscription.sessionId,
          enabled: false,
          reason,
          onActiveDesktop: false,
          composerText: subscription.lastComposer?.composerText ?? null,
        });
      }
      return;
    }

    const resolvedBySession = new Map<string, WindowTarget | { reason: WindowInputReason }>();
    const textBySession = new Map<string, string | null>();
    const questionBySession = new Map<string, Record<string, unknown> | null>();

    for (const subscription of subscriptions) {
      const { sessionId, source } = subscription;
      const id = keyOf(subscription);
      const isForced = force === subscription;

      let resolved = resolvedBySession.get(id);
      if (!resolved) {
        resolved = await resolveTarget(subscription, rows, snapshot);
        resolvedBySession.set(id, resolved);
      }

      if ("reason" in resolved) {
        emitComposer(subscription, {
          sessionId,
          enabled: false,
          reason: resolved.reason,
          onActiveDesktop: false,
          composerText: null,
        });
        emitQuestion(subscription, unavailableQuestion(sessionId, resolved.reason));
        continue;
      }

      if (onlyPid !== undefined && resolved.claudeMainPid !== onlyPid) continue;
      lastTargets.set(id, resolved);

      // Read only when it is free. A window on another Desktop would have to be dragged onto the
      // user's screen and back to be read, which is a visible flash; opening a session row is not
      // worth that, so the panel is offered an explicit load instead.
      //
      // While an observer is live the value arrives as an event, so the poll skips the read
      // entirely: that is the difference between walking a Chromium subtree every few seconds and
      // walking it when a human types.
      if (!textBySession.has(id)) {
        const skipRead = !isForced
          && observed.has(resolved.claudeMainPid)
          && subscription.lastComposer?.composerText !== undefined;
        if (skipRead) {
          textBySession.set(id, subscription.lastComposer?.composerText ?? null);
        } else {
          textBySession.set(id, await readIfFree(source, resolved, subscription, rows));
        }
      }
      // Claude only: the AskUserQuestion panel is a Claude Desktop surface, and Codex has no
      // equivalent to read. A Codex watcher gets no question half rather than an empty one, which is
      // what keeps "no panel" and "not applicable" apart in the panel.
      if (source === "claude" && !questionBySession.has(id)) {
        questionBySession.set(id, await readQuestionIfFree(resolved));
      }

      emitComposer(subscription, {
        sessionId,
        enabled: true,
        reason: null,
        onActiveDesktop: resolved.onActiveDesktop,
        composerText: textBySession.get(id) ?? null,
      });
      if (source !== "claude") continue;
      const state = questionBySession.get(id) ?? null;
      emitQuestion(subscription, {
        sessionId,
        enabled: state !== null,
        reason: null,
        present: state?.present === true,
        selectedIndices: (state?.selectedIndices as number[] | undefined) ?? [],
        otherText: (state?.otherText as string | undefined) ?? null,
        submitEnabled: (state?.submitEnabled as boolean | undefined) ?? null,
      });
    }
  }

  /**
   * The composer's text when reading costs nothing, and the observer registration that follows a
   * successful read.
   *
   * A transient read failure -- a web contents rebuilding its tree -- must NOT wipe the field with
   * null: the window is still there, and the panel adopts a null text as its own field contents.
   * Keeping the last known text until a read succeeds again is what makes a flapping tree render no
   * flicker.
   */
  async function readIfFree(
    source: WindowSource,
    target: WindowTarget,
    subscription: Subscription,
    rows: ProcessRow[],
  ): Promise<string | null> {
    if (!target.onActiveDesktop) return null;
    try {
      if (source === "claude") await call("ax-latch", { claudeMainPid: target.claudeMainPid });
      const answer = await call(verb(source, "read"), payloadFor(source, target));
      reviver.noteFound(target.claudeMainPid);
      // Claude only: the observer registers on Claude's composer element, and the revive path below
      // terminates Chromium renderer children of a CLAUDE process. Neither is right for Codex.
      if (source === "claude" && !observed.has(target.claudeMainPid)) {
        // Only after a read found the element: a revived web contents has a NEW composer element,
        // and observing the old one would deliver nothing forever.
        await call("composer-observe", targetPayload(target))
          .then(() => observed.add(target.claudeMainPid))
          .catch(() => {});
      }
      return typeof answer.text === "string" ? answer.text : null;
    } catch (error) {
      if (source === "claude" && error instanceof ComposerError && error.reason === "composer-missing") {
        observed.delete(target.claudeMainPid);
        const killed = reviver.noteMissing(target.claudeMainPid, rows, now());
        if (killed.length > 0) {
          // The contents was respawned. Give it a bounded moment rather than reporting a missing
          // composer the caller would immediately retry anyway.
          await call("composer-await", {
            ...targetPayload(target),
            timeoutMs: config.claudeRendererReviveWaitMs,
            pollMs: config.claudeComposerMaterializePollMs,
          }).catch(() => {});
        }
      }
      return subscription.lastComposer?.composerText ?? null;
    }
  }

  /**
   * The question panel's state when reading costs nothing.
   *
   * Null when the window sits on another Desktop, where Chromium builds no tree to read. The state
   * itself carries `present`, so "no panel in a readable window" and "window unreadable" stay
   * distinct: only the latter is null.
   */
  async function readQuestionIfFree(target: WindowTarget): Promise<Record<string, unknown> | null> {
    if (!target.onActiveDesktop) return null;
    try {
      await call("ax-latch", { claudeMainPid: target.claudeMainPid });
      return await call("question-read", targetPayload(target));
    } catch {
      return null;
    }
  }

  function unavailableQuestion(sessionId: string, reason: WindowInputReason): QuestionStatus {
    return {
      sessionId,
      enabled: false,
      reason,
      present: false,
      selectedIndices: [],
      otherText: null,
      submitEnabled: null,
    };
  }

  function emitComposer(subscription: Subscription, status: ComposerStatus) {
    if (sameComposer(subscription.lastComposer, status)) return;
    subscription.lastComposer = status;
    subscription.emit({ composer: status });
  }

  function emitQuestion(subscription: Subscription, status: QuestionStatus) {
    if (sameQuestion(subscription.lastQuestion, status)) return;
    subscription.lastQuestion = status;
    subscription.emit({ question: status });
  }

  // MARK: - Serialized commands

  /**
   * Runs `body` after every earlier command has finished.
   *
   * Every entry point that can move a window goes through here. Two overlapping writes to different
   * sessions in the same instance would otherwise interleave their move-in and move-back, and the
   * second restore would put the window back where the first one had already moved it from.
   */
  function serialize<T>(body: () => Promise<T>): Promise<T> {
    const result = queue.then(body, body);
    queue = result.catch(() => {});
    return result;
  }

  async function withResolvedTarget<T>(
    key: SessionKey,
    body: (target: WindowTarget) => Promise<T>,
  ): Promise<T> {
    const resolved = await resolveTarget(key, await processRows(), await auditSnapshot());
    if ("reason" in resolved) throw new ComposerError(resolved.reason);
    return await body(resolved);
  }

  return {
    /**
     * Watches one session. Returns unsubscribe.
     *
     * The first watcher of a session takes the editing lease, and the last one to leave returns it.
     * Later watchers share the same lease, so writes stay on the free active-Desktop path for as
     * long as anyone is looking.
     */
    watch(key: SessionKey, emit: (envelope: ComposerEnvelope) => void): () => void {
      const subscription: Subscription = {
        ...key,
        emit,
        lastComposer: null,
        lastQuestion: null,
      };
      const wasWatched = isWatched(key);
      subscriptions.add(subscription);
      startPolling();
      void serialize(async () => {
        if (!wasWatched) await beginEditingLease(key);
        // Forced for THIS subscription only: a fresh watcher must get a status even when nothing
        // changed, and forcing globally would rewrite every other panel's field mid-edit.
        await refresh({ force: subscription });
      });

      return () => {
        if (!subscriptions.delete(subscription)) return;
        void serialize(async () => {
          await endEditingLease(key);
          if (subscriptions.size === 0) {
            // Nobody is listening, and keeping Chromium's observers alive is exactly the continuous
            // traffic the focus gating exists to save.
            await helper.request("composer-unobserve-all").catch(() => {});
            observed.clear();
            lastTargets.clear();
          }
        });
        stopPollingIfIdle();
      };
    },

    /** Fills the composer without committing it. Never presses Return. */
    sync(key: SessionKey, text: string): Promise<string> {
      return serialize(async () => {
        const result = await withResolvedTarget(key, (target) =>
          withWindowHere(key.source, target, false, async () => {
            const answer = await call(verb(key.source, "write"), {
              ...payloadFor(key.source, target),
              text,
              settleMs: config.claudeComposerVerifySettleMs,
              pollMs: config.claudeComposerSettlePollMs,
            });
            return typeof answer.text === "string" ? answer.text : "";
          }));
        // The window's state just changed, and a caller that only sees the result would not learn
        // the new text or Desktop. Re-resolving keeps every watching panel agreeing with the real
        // window without waiting out the poll -- including the OTHER surface, which never saw the
        // request but is showing the same session. Change-only, so a panel whose text did not move
        // is not rewritten mid-edit.
        void refresh({});
        return result;
      });
    },

    /** Fills the composer and presses Return. This one deliberately fronts the window. */
    submit(key: SessionKey, text: string): Promise<string> {
      return serialize(async () => {
        const result = await withResolvedTarget(key, (target) =>
          withWindowHere(key.source, target, true, async () => {
            await call(verb(key.source, "write"), {
              ...payloadFor(key.source, target),
              text,
              settleMs: config.claudeComposerVerifySettleMs,
              pollMs: config.claudeComposerSettlePollMs,
            });
            const answer = await call(verb(key.source, "submit"), {
              ...payloadFor(key.source, target),
              settleMs: config.claudeComposerSubmitSettleMs,
              pollMs: config.claudeComposerSettlePollMs,
            });
            return typeof answer.text === "string" ? answer.text : "";
          }));
        void refresh({});
        return result;
      });
    },

    /**
     * Reads the composer, moving the window here if that is what it takes.
     *
     * An explicit load is the user asking for the round trip, so unlike the poll this is allowed to
     * bring the window over and put it back.
     */
    read(key: SessionKey): Promise<string> {
      return serialize(() =>
        withResolvedTarget(key, (target) =>
          withWindowHere(key.source, target, false, async () => {
            const answer = await call(verb(key.source, "read"), payloadFor(key.source, target));
            return typeof answer.text === "string" ? answer.text : "";
          })));
    },

    /** One AskUserQuestion interaction, answered with the panel's post-action state. */
    questionAction(sessionId: string, action: QuestionAction): Promise<QuestionStatus> {
      // Claude only, by construction: the AskUserQuestion panel is a Claude Desktop surface.
      const key: SessionKey = { source: "claude", sessionId };
      return serialize(() =>
        withResolvedTarget(key, (target) =>
          withWindowHere("claude", target, false, async () => {
            const state = await call("question-action", {
              ...targetPayload(target),
              action: action.kind,
              ...(action.kind === "select"
                ? { option: action.option, desired: action.desired }
                : {}),
              ...(action.kind === "other" ? { text: action.text } : {}),
            });
            return {
              sessionId,
              enabled: true,
              reason: null,
              present: state.present === true,
              selectedIndices: (state.selectedIndices as number[] | undefined) ?? [],
              otherText: (state.otherText as string | undefined) ?? null,
              submitEnabled: (state.submitEnabled as boolean | undefined) ?? null,
            } satisfies QuestionStatus;
          })));
    },

    /**
     * Node and text-area counts for a window whose composer was not found.
     *
     * The one breadcrumb separating the two very different causes: a tree Chromium never built (a
     * handful of bare groups -- measured at 14 nodes for a window on another Space, against 403 for
     * the same window on the active one), versus a full tree whose composer no longer carries the
     * description this build matches on.
     */
    census(sessionId: string): Promise<Record<string, unknown>> {
      return serialize(() =>
        withResolvedTarget({ source: "claude", sessionId }, (target) =>
          call("composer-census", targetPayload(target))));
    },

    /** Test seam. Ends polling and drops every subscription. */
    stop() {
      subscriptions.clear();
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

const KNOWN_REASONS = new Set<string>([
  "not-running",
  "terminal-only",
  "multiple-instances",
  "no-window",
  "ax-denied",
  "composer-missing",
  "move-failed",
  "restore-failed",
  "window-mover-unavailable",
  "write-failed",
  "verify-mismatch",
  "placement-unavailable",
  "focus-stolen",
  "ambiguous-window",
  "question-missing",
  "helper-unavailable",
]);

function sameComposer(a: ComposerStatus | null, b: ComposerStatus): boolean {
  return a !== null
    && a.enabled === b.enabled
    && a.reason === b.reason
    && a.onActiveDesktop === b.onActiveDesktop
    && a.composerText === b.composerText;
}

function sameQuestion(a: QuestionStatus | null, b: QuestionStatus): boolean {
  return a !== null
    && a.enabled === b.enabled
    && a.reason === b.reason
    && a.present === b.present
    && a.otherText === b.otherText
    && a.submitEnabled === b.submitEnabled
    && a.selectedIndices.length === b.selectedIndices.length
    && a.selectedIndices.every((value, index) => value === b.selectedIndices[index]);
}

/** The process-wide coordinator. One, for the reason in this file's header. */
export const composerCoordinator = createComposerCoordinator();
