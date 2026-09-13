// The backstop poll: what it re-resolves, what it is allowed to read, and what each
// watcher is told.
//
// Split from the coordinator because everything here is about a pass over the watched
// sessions, while what is left there is about the surfaces asking for one. The maps and
// sets are the coordinator's own, handed over by reference rather than copied: the poll
// and the commands have to agree about which pids are observed and which target each
// session last resolved to.

import type { DesktopAuditSnapshot, WindowInputReason, WindowTarget } from "@agentdesk/agent-feed-wire";
import { config } from "../config.ts";
import type { ProcessRow } from "./claudeSessionResolver.ts";
import type { RendererReviver } from "./rendererReviver.ts";
import {
  ComposerError,
  keyOf,
  sameComposer,
  sameQuestion,
  unavailableQuestion,
  type ComposerStatus,
  type QuestionStatus,
  type Subscription,
  type WindowSource,
} from "./composerTypes.ts";
import type { TargetResolver } from "./composerTargets.ts";
import { payloadFor, targetPayload, verb, type WindowAccess } from "./composerWindowAccess.ts";

export function createComposerPoll(
  access: WindowAccess,
  targets: TargetResolver,
  deps: {
    subscriptions: Set<Subscription>;
    /** Last resolved target per session, so a transient failure does not wipe a live field. */
    lastTargets: Map<string, WindowTarget>;
    /** Pids with a live AX observer. While observed, the poll skips value reads. */
    observed: Set<number>;
    reviver: RendererReviver;
    processRows: () => Promise<ProcessRow[]>;
    now: () => number;
  },
) {
  const { auditSnapshot, call } = access;
  const { resolveTarget } = targets;
  const { lastTargets, now, observed, processRows, reviver, subscriptions } = deps;

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
        // The skip is what the observer BUYS: while a pid is observed, the periodic pass does not
        // walk a Chromium subtree to re-read a value it would be told about anyway.
        //
        // It must not apply to the pass the observer itself triggered. `onlyPid` is set by nothing
        // except a helper push, so it marks an event-driven pass -- one that exists precisely
        // because the value moved. Skipping the read there made the whole event path a no-op:
        // the notification arrived, the refresh ran, and it re-emitted the text it already had.
        // Measured before this line existed: an out-of-band edit sat in the window for twenty
        // seconds while the stream kept reporting the old value.
        const skipRead = !isForced
          && onlyPid === undefined
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

  return { refresh };
}
