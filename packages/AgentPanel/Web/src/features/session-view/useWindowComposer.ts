"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  WindowComposerError,
  type WindowComposerClient,
  type WindowComposerStatus,
} from "@/features/window-composer/WindowComposerClient";
import { composerReasonText } from "@/features/session-view/SessionTerminalControls";

/**
 * The window-composer mechanism, extracted from the shared band so the band
 * itself is one component for every source. Inert -- and never subscribing --
 * when `active` is false, so a Pi session posts no `agent-window-input-watch`.
 *
 * Claude and Codex both reach the session's prompt through the owning desktop
 * app's window composer: the host resolves the session to its window (Claude
 * through the process tree, Codex through the app's own thread registry and
 * each window's accessibility header) and writes the field over Accessibility.
 *
 * The watch is FOCUS-gated: the field subscribes when focused and unwatches on
 * blur, which stops the host's resolution poll and the AX value observer while
 * nobody is composing. While focused the sync is automatic: the window's text
 * is prefilled on focus, every edit pushes the full value to the window after
 * a debounce, and value-changed events from the window reconcile the field --
 * an echo of our own write marks it in sync, an independent edit in the app
 * updates it while idle. Enter stays the one explicit action.
 */
export function useWindowComposer(
  host: WindowComposerClient,
  sessionId: string,
  active: boolean,
  windowName: string,
  /**
   * True when the owning app's composer reads are free on any Desktop (Codex Desktop materializes
   * accessibility trees for every window, so the watch status always carries the text). Free reads
   * skip the one automatic bring-and-move-back round trip that Claude's off-Desktop windows need.
   */
  freeReads: boolean,
) {
  const [status, setStatus] = useState<WindowComposerStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const statusRef = useRef<WindowComposerStatus | null>(null);
  const draftRef = useRef("");
  const edited = useRef(false);
  const inSync = useRef(true);
  const roundTripDone = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setDraftBoth = useCallback((text: string) => {
    draftRef.current = text;
    setDraft(text);
  }, []);

  const adopt = useCallback(
    (text: string) => {
      edited.current = false;
      inSync.current = true;
      setDraftBoth(text);
    },
    [setDraftBoth],
  );

  const change = useCallback(
    (value: string) => {
      edited.current = true;
      inSync.current = false;
      setDraftBoth(value);
    },
    [setDraftBoth],
  );

  const reportFailure = useCallback((failure: unknown) => {
    setError(
      failure instanceof WindowComposerError
        ? composerReasonText(failure.reason)
        : String((failure as Error).message ?? failure),
    );
  }, []);

  const run = useCallback(
    async (operation: () => Promise<string>) => {
      setPending(true);
      setError(null);
      try {
        adopt(await operation());
      } catch (failure) {
        reportFailure(failure);
      } finally {
        setPending(false);
      }
    },
    [adopt, reportFailure],
  );

  // The automatic push behind edits made while the window is already here. Deliberately silent: it
  // is the field's own echo, so no spinner freezes the field mid-keystroke, and the caption carries
  // the reason when the window refused. The result is NOT adopted: the write's read-back can lag the
  // draft (the user keeps typing while the host settles the write), and the field must never be
  // replaced by stale text. The write echo arrives as a status and the status handler reconciles it;
  // the draft stays so nothing is lost, and the next edit retries.
  const push = useCallback(async () => {
    // The focused watch borrows an off-Desktop Claude window once and reports it active before live
    // syncing begins. A false status means the lease was not acquired, so keep the draft local instead
    // of falling back to per-keystroke move-in/move-back traffic.
    if (statusRef.current?.onActiveDesktop !== true) return;
    try {
      await host.syncWindowComposer(sessionId, draftRef.current);
    } catch (failure) {
      reportFailure(failure);
    }
  }, [host, reportFailure, sessionId]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const text = await host.readWindowComposer(sessionId);
      // Adopt only when no keystroke landed while the read was in flight: the
      // window's text is older than a draft the user typed in the meantime, and
      // replacing the draft would delete what they just wrote.
      if (!edited.current) {
        adopt(text);
      }
    } catch (failure) {
      reportFailure(failure);
    }
  }, [adopt, host, reportFailure, sessionId]);

  const submitWindow = useCallback(
    () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      return run(() => host.submitWindowComposer(sessionId, draftRef.current));
    },
    [host, run, sessionId],
  );

  // The focus-gated watch: subscribing makes the host's forced status prefill
  // the field and starts the poll plus the AX value observer; the cleanup on
  // blur unwatches, which stops all of it.
  useEffect(() => {
    if (!active || !focused) return;
    roundTripDone.current = false;
    return host.subscribeWindowComposer(sessionId, (next) => {
      statusRef.current = next;
      setStatus(next);
      if (next.composerText === null) {
        // Compatibility fallback for a host that could resolve the window but could not acquire an
        // editing lease. Read once without disabling the local field.
        if (!freeReads && next.enabled && !next.onActiveDesktop && !roundTripDone.current) {
          roundTripDone.current = true;
          void load();
        }
        return;
      }
      if (!edited.current) {
        // Fresh prefill (or an independent edit while idle): the window is the source.
        inSync.current = true;
        setDraftBoth(next.composerText);
      } else if (next.composerText === draftRef.current) {
        // The echo of our own write: field and window agree again, so later independent edits are
        // adopted instead of being guarded forever by the "unsent edit" flag.
        edited.current = false;
        inSync.current = true;
      }
    });
  }, [active, host, focused, freeReads, load, sessionId, setDraftBoth]);

  // Debounced auto-sync while the owning window is here, either originally or under the focused watch's
  // editing lease. Every edit pushes the full value 500ms after the last keystroke.
  useEffect(() => {
    if (!active || !focused || inSync.current) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      void push();
    }, 500);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [active, draft, focused, push, status?.onActiveDesktop]);

  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    // Flush anything still inside the debounce window before the watch drops.
    if (!inSync.current) void push();
    setFocused(false);
  }, [push]);

  // Releases the native watch without flushing. Used only when another transport has taken the
  // draft after a known native refusal, so retrying a write into that refused window would be both
  // wasted work and a second owner for the same prompt.
  const stopWatching = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    setFocused(false);
  }, []);

  const enabled = status?.enabled === true;
  const notice =
    status === null
      ? focused
        ? `Looking for this session's ${windowName} window…`
        : null
      : enabled
        ? null
        : composerReasonText(status.reason);

  return {
    enabled,
    statusKnown: status !== null,
    onActiveDesktop: status?.onActiveDesktop === true,
    draft,
    change,
    submitWindow,
    pending,
    error,
    canSubmit: enabled && draft.trim().length > 0,
    notice,
    onFocus,
    onBlur,
    stopWatching,
  };
}
