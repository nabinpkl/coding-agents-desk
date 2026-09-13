// Borrowing a session's window onto this Desktop while a surface is watching it, and
// giving it back when the last one leaves.
//
// A lease is what keeps a write on the free active-Desktop path: without one, every
// keystroke into a window living on another Desktop would drag it here and put it back.

import type { WindowInputReason, WindowTarget } from "@agentdesk/agent-feed-wire";
import type { ProcessRow } from "./claudeSessionResolver.ts";
import { ComposerError, keyOf, logComposer, type SessionKey } from "./composerTypes.ts";
import type { TargetResolver } from "./composerTargets.ts";
import type { WindowAccess } from "./composerWindowAccess.ts";

export function createEditingLeases(
  access: WindowAccess,
  targets: TargetResolver,
  deps: {
    processRows: () => Promise<ProcessRow[]>;
    /** Whether any surface is still watching. The coordinator owns the subscriptions. */
    isWatched: (key: SessionKey) => boolean;
    /** Drops the coordinator's remembered target for a session it has just given back. */
    forgetTarget: (id: string) => void;
  },
) {
  const { auditSnapshot, awaitComposer, call, moveWindow, restoreWindow } = access;
  const { captureCodexWindows, resolveTarget } = targets;
  const { forgetTarget, isWatched, processRows } = deps;

  /** Windows borrowed onto this Desktop for a focused watcher, keyed by session. */
  const editingLeases = new Map<string, WindowTarget>();
  /** Why a lease could not be taken. Reported instead of a target until the watcher goes away. */
  const editingLeaseFailures = new Map<string, WindowInputReason>();

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
      forgetTarget(id);
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

  return {
    /** Why this session's lease could not be taken, if it could not. */
    failureFor(key: SessionKey): WindowInputReason | undefined {
      return editingLeaseFailures.get(keyOf(key));
    },
    begin: beginEditingLease,
    end: endEditingLease,
  };
}
