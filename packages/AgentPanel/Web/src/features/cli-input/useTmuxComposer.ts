"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAXIMUM_COMPOSER_IMAGE_BYTES,
  type ComposerCommand,
  type RailKey,
  type RailModifier,
  type TmuxComposerState,
  type TmuxComposerUnavailableReason,
  type TmuxQuestionState,
} from "@agentdesk/agent-feed-wire";
import {
  cycleModifier,
  heldModifiers,
  RAIL_MODIFIERS_OFF,
  releaseArmed,
  type ModifierState,
} from "@/features/keyboard/modifierLatch";
import type {
  SessionAddress,
  SidecarDataSource,
} from "@/features/activity-feed/data-source/SidecarDataSource";

/** How long after the last keystroke the pane is brought up to date. */
const PUSH_DEBOUNCE_MS = 90;
import {
  composerImageIds,
  type ComposerImage,
  type TmuxComposerHandle,
} from "@/features/cli-input/tmuxComposerHandle";

// Re-exported: the hook is the address its surface already imports, and these are what
// it hands back. The declarations live in `tmuxComposerHandle.ts`.
export {
  composerImageIds,
  tmuxComposerReasonText,
  type ComposerImage,
  type TmuxComposerHandle,
} from "@/features/cli-input/tmuxComposerHandle";

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
 * An inexact reading is not adopted over a draft. A box that wrapped cannot be reconstructed to
 * the character, and neither can one whose cursor is not at its end -- where what follows may not
 * even be the reader's, since Claude draws its own argument hint there once a command name is
 * complete. The sidecar says which kind of reading it is sending, and text that might not be
 * theirs must not overwrite text that is.
 */
export function useTmuxComposer(
  feed: Pick<
    SidecarDataSource,
    | "subscribeTmuxComposer"
    | "syncTmuxComposer"
    | "submitTmuxComposer"
    | "acceptTmuxComposerHint"
    | "dropTmuxComposerImage"
    | "pressTmuxComposerKey"
  >,
  session: SessionAddress,
  active: boolean,
): TmuxComposerHandle {
  const [state, setState] = useState<TmuxComposerState | null>(null);
  /** The dialog standing in the pane, off the same reading as the box. See the handle. */
  const [paneQuestion, setPaneQuestion] = useState<TmuxQuestionState | null>(null);
  /** Latched by the first reading that found a composer box; see `mirrored` on the handle. */
  const [mirrored, setMirrored] = useState(false);
  /** Latched by the first reading that found a PANE, box or not; see `paned` on the handle. */
  const [paned, setPaned] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [images, setImages] = useState<readonly ComposerImage[]>([]);
  const [commands, setCommands] = useState<readonly ComposerCommand[]>([]);

  const draftRef = useRef("");
  /**
   * The picture for each image number, and the pictures still waiting for one.
   *
   * Refs rather than state because the pairing is a sequence, not a render: an upload finishes,
   * and some readings later a number appears in the box that was not there before. That number is
   * the one Claude gave the image just sent, which is the only way this side can learn it -- the
   * sidecar cannot say, because reading the box straight after a paste catches it mid-redraw.
   */
  const previews = useRef(new Map<number, string>());
  const awaiting = useRef<Blob[]>([]);
  /** What the strip was last told to show, so typing beside it does not re-render it. */
  const shown = useRef("");
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

  /**
   * Keeps the strip agreeing with the tokens in the field.
   *
   * Run off the DRAFT rather than off the reading, so it is right in both directions: a new number
   * arrives when the pane redraws, and a token vanishes the moment somebody backspaces one out of
   * the field, before the pane has been told.
   */
  useEffect(() => {
    const ids = composerImageIds(draft);
    for (const id of ids) {
      if (previews.current.has(id)) continue;
      const blob = awaiting.current.shift();
      if (blob === undefined) break;
      previews.current.set(id, URL.createObjectURL(blob));
    }
    for (const [id, url] of [...previews.current]) {
      if (ids.includes(id)) continue;
      URL.revokeObjectURL(url);
      previews.current.delete(id);
    }
    // Cleared when the box is: a submitted turn takes its images with it, and a picture still
    // waiting for a number it will never get would be handed to the next image dropped.
    if (ids.length === 0) awaiting.current = [];
    const next = ids.map((id) => ({ id, url: previews.current.get(id) ?? null }));
    // Only when it actually moved. This runs on every keystroke, and a fresh array each time
    // would re-render the strip for each letter typed beside it.
    const signature = next.map((image) => `${image.id}:${image.url}`).join(" ");
    if (signature === shown.current) return;
    shown.current = signature;
    setImages(next);
  }, [draft]);

  // Every preview is an object URL, which the document holds until it is told otherwise.
  const forget = previews.current;
  useEffect(() => () => {
    for (const url of forget.values()) URL.revokeObjectURL(url);
    forget.clear();
  }, [forget]);

  /**
   * One push at a time, with whatever was typed during it folded into the next one.
   *
   * The debounce below decides WHEN to push, not how many may be in the air at once, and those
   * are different questions the moment a request takes longer than the 90ms window: a reader
   * typing steadily over a slow link has a second push starting while the first is still out.
   * Two things then go wrong, and the sidecar can only fix one of them. It serialises the turns
   * it receives, but it cannot put back an order the network already lost -- two requests sent in
   * order can arrive out of it, and the box is left holding the older draft.
   *
   * So the field pushes once, and a keystroke that lands mid-request sets a flag rather than
   * starting a second one. The loop then repeats with whatever the draft has become, which is one
   * request rather than one per keystroke, and always the newest text.
   */
  const pushing = useRef(false);
  const pushAgain = useRef(false);

  const push = useCallback(async () => {
    if (pushing.current) {
      pushAgain.current = true;
      return;
    }
    pushing.current = true;
    try {
      let sent: string;
      do {
        pushAgain.current = false;
        sent = draftRef.current;
        try {
          const next = await feed.syncTmuxComposer(sessionRef.current, sent);
          setState(next);
          setError(null);
          // Only clear the guard when the draft has not moved on underneath the request. Clearing
          // it regardless would let the next message adopt a reading taken before the last
          // keystroke.
          if (next.reason === null && draftRef.current === sent) edited.current = false;
        } catch (failure) {
          setError(String((failure as Error).message ?? failure));
        }
        // Only when the draft actually moved. A flag set by a keystroke that produced the same
        // text -- an edit and an undo inside one request -- has nothing left to send.
      } while (pushAgain.current && draftRef.current !== sent);
    } finally {
      pushing.current = false;
    }
  }, [feed]);

  const receive = useCallback((next: TmuxComposerState) => {
    setState(next);
    // Only ever from the stream. A push answers with what it ASKED the box to hold, and it cannot
    // know the menu that Claude then draws under it -- so taking the menu from a push would empty
    // the list on every keystroke and let the stream put it back a moment later, which is a list
    // that flickers away under the thumb reaching for it.
    //
    // Checked for its shape rather than taken on the type's word, for the same reason `text` is
    // below: a sidecar that does not know this field sends a message without it.
    setCommands(Array.isArray(next.commands) ? next.commands : []);
    // Checked for the shape it is documented in rather than for `text !== null`, because the two
    // differ exactly where it matters: a message that carries neither field -- a sidecar that does
    // not know this route, a proxy that swallowed the body -- has an `undefined` text, which is
    // not null, and would otherwise latch this session into a band with nothing behind it.
    // `reason === null` is the other half of the same claim.
    // Before the box check below, because a pane showing a dialog reports `no-composer` for the
    // dialog's whole duration -- and that is exactly when something wants to drive its keyboard.
    if (next.reason !== "no-pane") setPaned(true);
    if (next.reason !== null || typeof next.text !== "string") return;
    setMirrored(true);
    // An unsent edit is newer than anything the pane can show, and a reading that cannot be
    // trusted to the character may only fill a field that has nothing to lose.
    if (edited.current) return;
    if (!next.exact && draftRef.current.length > 0) return;
    setBoth(next.text);
  }, [setBoth]);

  // Everything resets on the session, including the draft: a draft belongs to the thread it was
  // written for, and carrying it across would type it into a different session's pane.
  useEffect(() => {
    setState(null);
    setPaneQuestion(null);
    setError(null);
    edited.current = false;
    pushAgain.current = false;
    setMirrored(false);
    setPaned(false);
    setCommands([]);
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
    return feed.subscribeTmuxComposer(sessionRef.current, {
      onComposer: receive,
      onQuestion: setPaneQuestion,
    });
  }, [feed, key, receive]);

  /**
   * Whether the last reading found a box that can be written to.
   *
   * A boolean rather than the reason itself, so this only moves on the two transitions that
   * matter and not on every message the stream sends. Null state is not reachable: nothing has
   * been read yet, and the first reading is what says whether there is anything there.
   */
  const reachable = state !== null && state.reason === null;

  // The debounced push behind edits. One effect on the value rather than a call beside each of the
  // places that change it, which is how one of them ends up forgotten.
  //
  // `reachable` is in here for both of its directions, and the second one is the bug it fixes.
  //
  //   Going false, it CANCELS. Typing into a session showing a dialog would otherwise spend a
  //   request per debounce window on a box that cannot be written, each answering `no-composer`.
  //
  //   Going true, it PUSHES -- and this is the fix. A draft typed while the pane was unreachable
  //   is still unsent, because the push it wanted was refused and `edited` stayed set. Nothing
  //   else would carry it: the stream will not adopt over an unsent edit, and this effect used to
  //   wake only on the draft moving, so the text sat in a field the band had just stopped warning
  //   about. The panel looked mirrored and was not, which is the failure this module cares about
  //   most. Now the reading that says the box is back is what sends it.
  //
  // Safe on the FIRST reading of a session because `edited` is false until somebody types: a
  // reader who has typed nothing pushes nothing, so opening a card cannot blank the box of
  // whoever is sitting at that keyboard.
  useEffect(() => {
    if (!key || !edited.current || !reachable) return;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      pushTimer.current = null;
      void push();
    }, PUSH_DEBOUNCE_MS);
    return () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
    };
  }, [draft, key, push, reachable]);

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

  /**
   * Sends each image, then hands the field back to the pane.
   *
   * Three things in an order that is the whole of the logic. The draft goes first, because a drop
   * lands at the end of what the box holds and text still sitting in the debounce would arrive
   * after the image otherwise. Then the images, one at a time and awaited, because Claude numbers
   * them in the order they arrive. Then `edited` is cleared: what comes back is not what was sent
   * -- Claude replaces the path with its own `[Image #N]` -- so the reading has to win, and it
   * would not against a guard that says the field is newer.
   */
  const drop = useCallback(async (files: readonly Blob[]) => {
    if (files.length === 0) return;
    if (pushTimer.current) {
      clearTimeout(pushTimer.current);
      pushTimer.current = null;
    }
    setPending(true);
    setError(null);
    try {
      // Size is the one thing worth judging before the upload, because encoding a file this side
      // is what the upload costs. WHETHER it is an image is not judged here at all: the sidecar
      // sniffs the bytes, and a second opinion from the browser's own `type` -- which is empty on
      // some platforms for files that are perfectly good images -- could only disagree with it.
      const sendable = files.filter((file) => file.size <= MAXIMUM_COMPOSER_IMAGE_BYTES);
      if (sendable.length < files.length) {
        setError(
          `An image has to be under ${MAXIMUM_COMPOSER_IMAGE_BYTES / (1024 * 1024)} MB.`,
        );
      }
      if (sendable.length === 0) return;
      if (edited.current) {
        const synced = await feed.syncTmuxComposer(sessionRef.current, draftRef.current);
        setState(synced);
        if (synced.reason !== null) return;
      }
      for (const file of sendable) {
        const after = await feed.dropTmuxComposerImage(sessionRef.current, file);
        setState(after);
        if (after.reason !== null) return;
        // Only once the pane has it. A picture queued for an image that never landed would be
        // shown beside the next one that did.
        awaiting.current.push(file);
      }
      edited.current = false;
    } catch (failure) {
      setError(String((failure as Error).message ?? failure));
    } finally {
      setPending(false);
    }
  }, [feed]);

  const remove = useCallback((id: number) => {
    // One space either side goes with the token, and one comes back when it had both. That is
    // what keeps "alpha [Image #1] omega" reading as "alpha omega" while a token at the head of
    // the box does not leave the text starting with a space.
    const gone = draftRef.current.replace(
      new RegExp(` ?\\[Image #${id}\\] ?`),
      (taken) => (taken.startsWith(" ") && taken.endsWith(" ") ? " " : ""),
    );
    edited.current = true;
    setBoth(gone);
  }, [setBoth]);

  const onBlur = useCallback(() => {
    if (pushTimer.current) {
      clearTimeout(pushTimer.current);
      pushTimer.current = null;
    }
    // Flush whatever was still inside the debounce window, so the pane is never left holding
    // something older than the field that was just left.
    if (edited.current) void push();
  }, [push]);

  /**
   * The key rail, for a phone whose keyboard has no Esc, Tab, Ctrl or arrows.
   *
   * Those are most of how Claude's prompt box is driven -- Escape clears it or interrupts, the
   * arrows walk history and move a cursor, Ctrl+C stops a turn -- and none of them are on a touch
   * keyboard. Without this a phone can write prose into a session and then not be able to take it
   * back.
   *
   * A press does NOT flush the draft first, and that is deliberate: these keys are how a reader
   * corrects the box, so making them wait for a debounced push would send the text they are about
   * to undo. The pane answers on the stream, and the field adopts whatever it says.
   */
  const [modifiers, setModifiers] = useState(RAIL_MODIFIERS_OFF);
  const modifiersRef = useRef(modifiers);
  modifiersRef.current = modifiers;

  const pressKey = useCallback((key: RailKey) => {
    const held = heldModifiers(modifiersRef.current);
    setModifiers(releaseArmed);
    // The pane is about to change under the field, and what it becomes is not predictable from
    // here, so the reading that comes back is the truth rather than the draft in hand.
    edited.current = false;
    void feed.pressTmuxComposerKey(sessionRef.current, key, held)
      .then((next) => setState(next))
      .catch((failure) => setError(String((failure as Error).message ?? failure)));
  }, [feed]);

  const toggleModifier = useCallback((modifier: RailModifier) => {
    setModifiers((current) => ({ ...current, [modifier]: cycleModifier(current[modifier]) }));
  }, []);

  const chooseCommand = useCallback((name: string) => {
    edited.current = true;
    setBoth(`${name} `);
  }, [setBoth]);

  return {
    // Latched, so the band survives the session it mirrors exiting. `state` still carries the
    // live answer, which is what `reason` reports.
    mirrored,
    paned,
    reason: state?.reason ?? null,
    paneQuestion,
    draft,
    // Only while the box is empty, which is the only time Claude offers one and the only time a
    // placeholder can be seen. A stale hint beside typed text would be a suggestion for nothing.
    hint: draft.length === 0 ? state?.hint ?? null : null,
    change,
    submit,
    accept,
    drop,
    images,
    remove,
    modifiers,
    toggleModifier,
    pressKey,
    commands,
    chooseCommand,
    pending,
    error,
    onBlur,
  };
}
