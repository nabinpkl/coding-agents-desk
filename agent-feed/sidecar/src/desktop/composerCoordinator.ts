import type { WindowTarget } from "@agentdesk/agent-feed-wire";
import { config } from "@/config/config";
import { liveProcessRows, type ProcessRow } from "@/desktop/claudeSessionResolver";
import { type ControlHelper, controlHelper } from "@/desktop/controlHelper";
import { createRendererReviver, type RendererReviver } from "@/desktop/rendererReviver";
import { createEditingLeases } from "@/desktop/composerLeases";
import { createTargetResolver } from "@/desktop/composerTargets";
import {
  ComposerError,
  type ComposerEnvelope,
  type ComposerStatus,
  type QuestionAction,
  type QuestionStatus,
  type SessionKey,
  type Subscription,
  type WindowSource,
} from "@/desktop/composerTypes";
import { createComposerPoll } from "@/desktop/composerWatchPoll";
import { createWindowAccess, payloadFor, targetPayload, verb } from "@/desktop/composerWindowAccess";

// Re-exported because `http/windowRoutes.ts` reaches for them through the coordinator, which is
// the surface it talks to. The declarations live in `composerTypes.ts`.
export {
  ComposerError,
  type ComposerEnvelope,
  type ComposerStatus,
  type QuestionAction,
  type QuestionStatus,
  type SessionKey,
  type WindowSource,
};

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
  /** Last resolved target per session, so a transient failure does not wipe a live field. */
  const lastTargets = new Map<string, WindowTarget>();
  /** Pids with a live AX observer. While observed, the poll skips value reads. */
  const observed = new Set<number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Serializes every window-moving operation. See the file header. */
  let queue: Promise<unknown> = Promise.resolve();

  const access = createWindowAccess(helper);
  // The two refer to each other: a lease is taken against a resolved target, and resolving
  // short-circuits on a lease that could not be taken. Both references are deferred, so the
  // order they are constructed in does not matter.
  const targets = createTargetResolver(access, (key) => leases.failureFor(key));
  const leases = createEditingLeases(access, targets, {
    processRows,
    isWatched,
    forgetTarget: (id) => lastTargets.delete(id),
  });
  const { refresh } = createComposerPoll(access, targets, {
    subscriptions,
    lastTargets,
    observed,
    reviver,
    processRows,
    now,
  });
  const { auditSnapshot, call, withWindowHere } = access;
  const { resolveTarget } = targets;

  helper.onPush((event) => {
    const pid = typeof event.pid === "number" ? event.pid : null;
    switch (event.type) {
      // The helper reports the PROCESS; which sessions that is depends on resolution, which lives
      // here. Refreshing only the sessions on that pid keeps an unrelated instance's typing from
      // costing every watcher an AX read.
      case "composer-changed":
      case "question-changed":
        if (pid !== null) void refresh({ onlyPid: pid });
        return;
      // An application appeared or went away, or the Desktop changed under the windows. Both
      // invalidate resolution for every watched session rather than one pid's worth, and neither
      // is something a pid filter could narrow: the launch case is precisely the one where no
      // session has that pid yet.
      case "workspace-changed":
      case "space-changed":
        void refresh({});
        return;
      default:
        return;
    }
  });

  function isWatched(key: SessionKey): boolean {
    for (const subscription of subscriptions) {
      if (subscription.sessionId === key.sessionId && subscription.source === key.source) return true;
    }
    return false;
  }

  // MARK: - Polling

  /**
   * The backstop, and the window-system subscription that demoted it to one.
   *
   * Composer text, the question panel, application lifecycle, and Desktop switches all arrive as
   * events now. What remains unpushed is the part macOS does not publish: a session is resolved
   * through a `claude --resume <id>` CHILD process, and there is no notification for an arbitrary
   * process starting or exiting short of EndpointSecurity, which is its own entitlement and its
   * own TCC grant for something a `/bin/ps` scan answers in milliseconds.
   *
   * So this interval still exists and still re-resolves everything. It is just no longer how
   * anything is normally noticed, which is what lets it run at a backstop cadence instead of a
   * responsive one. Said out loud rather than described as event-driven, because a reader who
   * believes the poll is gone will not understand why a new terminal session takes a while to
   * appear.
   */
  function startPolling() {
    if (timer !== null) return;
    timer = setInterval(() => void refresh({}), pollIntervalMs);
    void helper.request("workspace-observe").catch(() => {});
  }

  function stopPollingIfIdle() {
    if (subscriptions.size > 0 || timer === null) return;
    clearInterval(timer);
    timer = null;
    void helper.request("workspace-unobserve").catch(() => {});
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

  async function withResolvedTarget<T>(key: SessionKey, body: (target: WindowTarget) => Promise<T>): Promise<T> {
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
        if (!wasWatched) await leases.begin(key);
        // Forced for THIS subscription only: a fresh watcher must get a status even when nothing
        // changed, and forcing globally would rewrite every other panel's field mid-edit.
        await refresh({ force: subscription });
      });

      return () => {
        if (!subscriptions.delete(subscription)) return;
        void serialize(async () => {
          await leases.end(key);
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
          }),
        );
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
          }),
        );
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
          }),
        ),
      );
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
              ...(action.kind === "select" ? { option: action.option, desired: action.desired } : {}),
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
          }),
        ),
      );
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
        withResolvedTarget({ source: "claude", sessionId }, (target) => call("composer-census", targetPayload(target))),
      );
    },

    /** Test seam. Ends polling and drops every subscription. */
    stop() {
      subscriptions.clear();
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

/** The process-wide coordinator. One, for the reason in this file's header. */
export const composerCoordinator = createComposerCoordinator();
