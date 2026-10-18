// Reaching a Claude Desktop or Codex window: the one helper verb wrapper every other
// call goes through, moving a window between Desktops, and running something with the
// window here before putting it back.
//
// Everything here is timing and sequencing policy over a helper that only dispatches:
// how long to keep re-reading after a move, whether to retry a restore, and what a
// frontmost change means. None of it is a native capability, which is why it lives in
// TypeScript rather than in the helper.

import type { DesktopAuditSnapshot, WindowTarget } from "@agentdesk/agent-feed-wire";
import { config } from "@/config/config";
import { ControlHelperError, type ControlHelper } from "@/desktop/controlHelper";
import { asReason, ComposerError, logComposer, type WindowSource } from "@/desktop/composerTypes";

export function targetPayload(target: WindowTarget) {
  return {
    claudeMainPid: target.claudeMainPid,
    windowID: target.windowID,
    bounds: target.bounds,
  };
}

/**
 * The verb for one intent, per source.
 *
 * Claude addresses a window by pid plus frame (Accessibility exposes no window id for it), Codex by
 * WindowServer id. Same intent, different call, and this is the one place that knows.
 */
export function verb(source: WindowSource, intent: "read" | "write" | "submit" | "await"): string {
  return source === "codex" ? `codex-composer-${intent}` : `composer-${intent}`;
}

export function payloadFor(source: WindowSource, target: WindowTarget): Record<string, unknown> {
  return source === "codex" ? { windowID: target.windowID, mainPid: target.claudeMainPid } : targetPayload(target);
}

export function createWindowAccess(helper: ControlHelper) {
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

  /** Waits for a moved window to build its tree, with the budget this source needs. */
  async function awaitComposer(source: WindowSource, target: WindowTarget): Promise<void> {
    await call(verb(source, "await"), {
      ...payloadFor(source, target),
      timeoutMs: source === "codex" ? config.codexTreeMaterializeTimeoutMs : config.claudeComposerMaterializeTimeoutMs,
      pollMs: config.claudeComposerMaterializePollMs,
    });
  }

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
    // Boxed, so a body that throws `undefined` still counts as having failed.
    let failure: { error: unknown } | undefined;
    try {
      outcome = await body();
    } catch (error) {
      failure = { error };
      outcome = undefined as T;
    }

    if (moved) await restoreWindow(target);

    if (failure) throw failure.error;

    // Sampled after the restore so the whole sequence is covered. Nothing above activates an
    // application, so a change means an assumption broke; it cannot be undone, only reported.
    if (!allowsActivation && frontmostBefore !== null && (await frontmostPid()) !== frontmostBefore) {
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

  async function auditSnapshot(): Promise<DesktopAuditSnapshot> {
    return (await helper.request("desktop-audit")) as unknown as DesktopAuditSnapshot;
  }

  return {
    call,
    auditSnapshot,
    frontmostPid,
    moveWindow,
    restoreWindow,
    awaitComposer,
    withWindowHere,
  };
}

/** What `createWindowAccess` hands back, so the other parts can name it. */
export type WindowAccess = ReturnType<typeof createWindowAccess>;
