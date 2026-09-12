"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TmuxComposerState, TmuxComposerUnavailableReason } from "@agentdesk/agent-feed-wire";
import type {
  SessionAddress,
  SidecarDataSource,
} from "../activity-feed/data-source/SidecarDataSource";

/** How long after the last keystroke the pane is brought up to date. */
const PUSH_DEBOUNCE_MS = 90;

export interface TmuxComposerHandle {
  /**
   * Whether this session is one the panel mirrors, which LATCHES on the first pane it sees.
   *
   * Sticky rather than live, and that is the whole point of it being separate from `reason`. A
   * session that exits loses its pane, and a band chosen on the live answer would swap itself out
   * from under whoever was mid-sentence, taking their draft with it and explaining nothing. This
   * keeps the field where it is and lets `reason` say what happened, which is what the composer
   * beside it already does for a terminal session that stopped running.
   */
  mirrored: boolean;
  /** Why the pane cannot be reached right now, or null while it can. */
  reason: TmuxComposerUnavailableReason | null;
  draft: string;
  change: (value: string) => void;
  /**
   * Claude's own suggestion for this empty box, or null when it is offering none.
   *
   * Shown the way the terminal shows it -- faint, in the box, taking no space in the value -- and
   * never pushed. `accept` is what turns it into text.
   */
  hint: string | null;
  /** Brings the pane up to date, then presses Return in it. */
  submit: () => Promise<void>;
  /** Takes Claude up on `hint`, by pressing Tab in the pane the way a reader there would. */
  accept: () => Promise<void>;
  pending: boolean;
  error: string | null;
  /**
   * Flushes an edit still inside the debounce, so leaving the field never leaves the pane behind.
   *
   * There is deliberately no focus half. A polled read had to be refreshed at the moment somebody
   * was about to act on it; a stream is already current.
   */
  onBlur: () => void;
}

/**
 * The panel's composer, mirrored into the prompt box of the CLI this session is running in.
 *
 * The tmux twin of `useWindowComposer`, and deliberately the same shape: a draft held here, a
 * debounced push outward, a read that reconciles inward, and one `edited` flag deciding which of
 * the two wins. Every difference from that hook is a difference between a native window and a
 * terminal screen, and there are three worth knowing:
 *
 * The push sends the whole desired text rather than a delta. Only the sidecar can see what the box
 * holds, and it reads it in the same breath as it writes; a delta computed here would be computed
 * against an observation that already made a round trip, and the person at that keyboard is typing
 * too.
 *
 * The read is a subscription, and it runs whenever this band is the input surface rather than only
 * while the field has focus -- typing in the terminal half and having the field agree afterwards
 * is the whole point of it being two-way. A screen has no change event of its own, so the sidecar
 * makes one out of the pane's output and reports only differences; nothing here is on a timer, and
 * a session nobody is typing at costs nothing at all.
 *
 * A wrapped reading is not adopted over a draft. Claude word-wraps its own box, so a composer that
 * ran onto a second row cannot be reconstructed to the character; the sidecar says so, and text
 * that might be off by a space must not overwrite text the reader actually typed.
 */
export function useTmuxComposer(
  feed: Pick<
    SidecarDataSource,
    | "subscribeTmuxComposer"
    | "syncTmuxComposer"
    | "submitTmuxComposer"
    | "acceptTmuxComposerHint"
  >,
  session: SessionAddress,
  active: boolean,
): TmuxComposerHandle {
  const [state, setState] = useState<TmuxComposerState | null>(null);
  /** Latched by the first reading that found a pane; see `mirrored` on the handle. */
  const [mirrored, setMirrored] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draftRef = useRef("");
  /** An edit that has not been seen in the pane yet. Guards the read from overwriting it. */
  const edited = useRef(false);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The address is a fresh object on every render of the caller, so it cannot be a dependency.
  // Held in a ref and keyed by identity, the same way `useCliInput` does it.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const key = active ? `${session.source}/${session.sessionId}` : null;

  const setBoth = useCallback((text: string) => {
    draftRef.current = text;
    setDraft(text);
  }, []);

  const change = useCallback((value: string) => {
    edited.current = true;
    setBoth(value);
  }, [setBoth]);

  const push = useCallback(async () => {
    const wanted = draftRef.current;
    try {
      const next = await feed.syncTmuxComposer(sessionRef.current, wanted);
      setState(next);
      setError(null);
      // Only clear the guard when the draft has not moved on underneath the request. Clearing it
      // regardless would let the next message adopt a reading taken before the last keystroke.
      if (next.reason === null && draftRef.current === wanted) edited.current = false;
    } catch (failure) {
      setError(String((failure as Error).message ?? failure));
    }
  }, [feed]);

  const receive = useCallback((next: TmuxComposerState) => {
    setState(next);
    // Checked for the shape it is documented in rather than for `text !== null`, because the two
    // differ exactly where it matters: a message that carries neither field -- a sidecar that does
    // not know this route, a proxy that swallowed the body -- has an `undefined` text, which is
    // not null, and would otherwise latch this session into a band with nothing behind it.
    // `reason === null` is the other half of the same claim.
    if (next.reason !== null || typeof next.text !== "string") return;
    setMirrored(true);
    // An unsent edit is newer than anything the pane can show, and a reading that cannot be
    // trusted to the character may only fill a field that has nothing to lose.
    if (edited.current) return;
    if (next.wrapped && draftRef.current.length > 0) return;
    setBoth(next.text);
  }, [setBoth]);

  // Everything resets on the session, including the draft: a draft belongs to the thread it was
  // written for, and carrying it across would type it into a different session's pane.
  useEffect(() => {
    setState(null);
    setError(null);
    edited.current = false;
    setMirrored(false);
    setBoth("");
  }, [key, setBoth]);

  // One subscription per session, for as long as this band is the input surface.
  //
  // No timer and no visibility gate, and losing both is the point: the sidecar speaks when the
  // pane writes and says nothing otherwise, so an idle session costs nothing whether or not
  // anyone is looking at it. The gate that used to stand in for that is gone with it -- it made a
  // backgrounded tab report a session as having no pane at all, which is a different claim.
  useEffect(() => {
    if (!key) return;
    return feed.subscribeTmuxComposer(sessionRef.current, receive);
  }, [feed, key, receive]);

  // The debounced push behind edits. One effect on the value rather than a call beside each of the
  // places that change it, which is how one of them ends up forgotten.
  useEffect(() => {
    if (!key || !edited.current) return;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      pushTimer.current = null;
      void push();
    }, PUSH_DEBOUNCE_MS);
    return () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
    };
  }, [draft, key, push]);

  const submit = useCallback(async () => {
    if (pushTimer.current) {
      clearTimeout(pushTimer.current);
      pushTimer.current = null;
    }
    setPending(true);
    setError(null);
    try {
      // Brought up to date first, and awaited: Return presses whatever the box holds, so sending
      // it while a debounced push was still in flight would submit half a sentence.
      const synced = await feed.syncTmuxComposer(sessionRef.current, draftRef.current);
      setState(synced);
      if (synced.reason !== null) return;
      const after = await feed.submitTmuxComposer(sessionRef.current);
      setState(after);
      if (after.reason !== null) return;
      edited.current = false;
      setBoth("");
    } catch (failure) {
      setError(String((failure as Error).message ?? failure));
    } finally {
      setPending(false);
    }
  }, [feed, setBoth]);

  /**
   * Takes the suggestion, and then says nothing about the result.
   *
   * The pane redraws with the words in it and the stream reports that, which is also what makes
   * this safe while the reader has typed nothing: `edited` is false, so the reading is adopted.
   */
  const accept = useCallback(async () => {
    setError(null);
    try {
      setState(await feed.acceptTmuxComposerHint(sessionRef.current));
    } catch (failure) {
      setError(String((failure as Error).message ?? failure));
    }
  }, [feed]);

  const onBlur = useCallback(() => {
    if (pushTimer.current) {
      clearTimeout(pushTimer.current);
      pushTimer.current = null;
    }
    // Flush whatever was still inside the debounce window, so the pane is never left holding
    // something older than the field that was just left.
    if (edited.current) void push();
  }, [push]);

  return {
    // Latched, so the band survives the session it mirrors exiting. `state` still carries the
    // live answer, which is what `reason` reports.
    mirrored,
    reason: state?.reason ?? null,
    draft,
    // Only while the box is empty, which is the only time Claude offers one and the only time a
    // placeholder can be seen. A stale hint beside typed text would be a suggestion for nothing.
    hint: draft.length === 0 ? state?.hint ?? null : null,
    change,
    submit,
    accept,
    pending,
    error,
    onBlur,
  };
}

/** What each reason means to somebody looking at the field. */
export function tmuxComposerReasonText(reason: TmuxComposerUnavailableReason): string {
  switch (reason) {
    case "no-pane":
      return "This session is not running in a terminal, so there is no composer to mirror.";
    case "tmux-unavailable":
      return "tmux is not answering, so this session's composer cannot be reached.";
    case "no-composer":
      return "This session's terminal is redrawing. Its composer will come back.";
  }
}
