"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ComposerPaste, TmuxComposerState } from "@agentdesk/agent-feed-wire";
import type {
  SessionAddress,
  SidecarDataSource,
} from "@/features/activity-feed/data-source/SidecarDataSource";
import {
  composerImageIds,
  composerPasteTokens,
  type ComposerImage,
} from "@/features/cli-input/tmuxComposerHandle";

/**
 * What a mirrored composer is holding that is NOT editable text.
 *
 * Claude's prompt box carries two things a reader cannot type into or edit in place, and both are
 * the same shape: a token in the text standing for content that lives inside that process. An
 * image is `[Image #N]` and its bytes are in a table there. A long paste is `[Pasted text #N]`
 * and so are its words -- measured on a live pane against v2.1.263, a bracketed paste is literal
 * at 800 characters and at three lines and collapsed at 801 and at four. Either way one backspace
 * takes the whole thing, and neither can be changed from the middle.
 *
 * So they are drawn beside the field rather than in it, and this is the bookkeeping behind both
 * strips. It is separate from the hook that owns the draft because it is a separate job: that one
 * is a mirror -- a draft, a debounced push, a reading that reconciles -- and this one is a
 * register of what the box is carrying, keyed to tokens whose numbering belongs to Claude.
 *
 * Everything here runs off the DRAFT rather than off the reading, in both halves. That is what
 * makes it right in both directions: a token appears when the pane redraws and the reading brings
 * it, and it disappears the moment somebody backspaces it out of the field, which is before the
 * pane has been told anything.
 */
export function useComposerAttachments({
  feed,
  session,
  draft,
  draftRef,
  edit,
  report,
}: {
  feed: Pick<SidecarDataSource, "readTmuxComposerPaste">;
  /** The address, held by the caller, because it is a fresh object on every render. */
  session: RefObject<SessionAddress>;
  draft: string;
  draftRef: RefObject<string>;
  /** Replaces the field's text and marks it as an edit the pane has not seen. */
  edit: (text: string) => void;
  /** Where a failed fetch goes, which is the band's own error line. */
  report: (message: string) => void;
}) {
  const [images, setImages] = useState<readonly ComposerImage[]>([]);
  const [pastes, setPastes] = useState<readonly ComposerPaste[]>([]);

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
  /**
   * What the last reading said about each handle, keyed by handle.
   *
   * A ref rather than state because it is a lookup the draft is rendered against, not a thing to
   * render. Keyed by the handle itself and not by its number, because Claude writes two spellings
   * for the same paste -- `[Pasted text #1]` and `[Pasted text #1 +38 lines]` -- and only the box
   * says which one it used.
   */
  const reported = useRef(new Map<string, ComposerPaste>());
  /**
   * Which dropped file each image number is, as readings report it.
   *
   * Claude renumbers an image the sidecar had to drop again -- an edit that retyped across it --
   * so `#1` becomes `#2` while it is the same picture. The file is what lets the preview move with
   * it instead of the strip showing a bare number for an image this panel sent.
   */
  const imageFiles = useRef(new Map<number, string>());

  /** Keeps the image strip agreeing with the tokens in the field. */
  useEffect(() => {
    const ids = composerImageIds(draft);
    for (const id of ids) {
      if (previews.current.has(id)) continue;
      const file = imageFiles.current.get(id);
      const renumbered = file === undefined
        ? undefined
        : [...previews.current.keys()].find((was) => !ids.includes(was) && imageFiles.current.get(was) === file);
      if (renumbered !== undefined) {
        previews.current.set(id, previews.current.get(renumbered)!);
        previews.current.delete(renumbered);
        continue;
      }
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

  /**
   * Keeps the paste chips agreeing with the handles in the field.
   *
   * A handle the field is carrying that no reading has described yet is shown as one whose words
   * are not held, which is the honest answer until a reading says otherwise: the alternative is
   * offering a preview that then cannot be produced.
   */
  useEffect(() => {
    const next = composerPasteTokens(draft).map((token) => reported.current.get(token)
      ?? { token, id: Number(/#(\d+)/.exec(token)?.[1] ?? 0), held: null });
    setPastes((was) => (
      was.length === next.length
        && was.every((had, at) => had.token === next[at]?.token
          && had.held?.chars === next[at]?.held?.chars)
        ? was
        : next
    ));
  }, [draft]);

  // Every preview is an object URL, which the document holds until it is told otherwise.
  const forget = previews.current;
  useEffect(() => () => {
    for (const url of forget.values()) URL.revokeObjectURL(url);
    forget.clear();
  }, [forget]);

  /**
   * Takes what a reading says about the handles in the box.
   *
   * Checked for its shape rather than taken on the type's word, the way the command menu beside it
   * is: a sidecar that predates this field sends a message without it, and the chips should then
   * say nothing rather than throw under a reader mid-sentence.
   */
  const observe = useCallback((next: TmuxComposerState) => {
    if (Array.isArray(next.images)) {
      for (const image of next.images) {
        if (image.file !== null) imageFiles.current.set(image.id, image.file);
      }
    }
    if (!Array.isArray(next.pastes)) return;
    for (const paste of next.pastes) reported.current.set(paste.token, paste);
  }, []);

  /**
   * Holds on to a picture until the number Claude gives it appears in the box.
   *
   * Called only once the pane has taken the image: a picture queued for one that never landed
   * would be shown beside the next one that did.
   */
  const queue = useCallback((file: Blob) => {
    awaiting.current.push(file);
  }, []);

  /** Forgets every pairing, for a session the field has moved away from. */
  const clear = useCallback(() => {
    for (const url of previews.current.values()) URL.revokeObjectURL(url);
    previews.current.clear();
    awaiting.current = [];
    reported.current.clear();
    imageFiles.current.clear();
    shown.current = "";
    setImages([]);
    setPastes([]);
  }, []);

  /**
   * Asks the sidecar for the words behind one handle, which is what makes a chip openable.
   *
   * Not cached. A paste does not change once it is made, so a second look is the same answer --
   * but it is also the rarest request this surface makes, and a cache of sixteen-kilobyte strings
   * kept alive for the life of a session buys one round trip nobody is waiting on.
   */
  const previewPaste = useCallback(async (token: string): Promise<string | null> => {
    try {
      return await feed.readTmuxComposerPaste(session.current, token);
    } catch (failure) {
      report(String((failure as Error).message ?? failure));
      return null;
    }
  }, [feed, report, session]);

  /**
   * Puts the words behind a handle back in the field, so they can be edited again.
   *
   * The recovery the binding exists for. A reader whose panel reloaded mid-message comes back to
   * an empty field looking at a box that holds a handle: the message is not lost -- it is in the
   * pane and the sidecar is holding the words -- but it is not anywhere they can change it.
   *
   * The push that follows clears the handle and re-pastes, which Claude collapses again into a
   * new one, so this does not escape the collapse and is not trying to. What it moves is which
   * side holds the copy a reader can work on.
   */
  const expandPaste = useCallback(async (token: string) => {
    const text = await previewPaste(token);
    if (text === null) return;
    edit(draftRef.current.replace(token, text));
  }, [draftRef, edit, previewPaste]);

  /**
   * Takes one attachment back out, which is deleting its token from the text.
   *
   * One space either side goes with the token and one comes back when it had both. That keeps
   * `alpha [Image #1] omega` reading as `alpha omega`, while a token at the head of the box does
   * not leave the text starting with a space. The ordinary push carries the change, so there is
   * no second way into somebody's pane.
   */
  const removeToken = useCallback((token: string | RegExp) => {
    edit(draftRef.current.replace(
      token instanceof RegExp ? token : spacedToken(token),
      (taken) => (taken.startsWith(" ") && taken.endsWith(" ") ? " " : ""),
    ));
  }, [draftRef, edit]);

  const removeImage = useCallback((id: number) => {
    removeToken(new RegExp(` ?\\[Image #${id}\\] ?`));
  }, [removeToken]);

  const removePaste = useCallback((token: string) => {
    removeToken(token);
  }, [removeToken]);

  return {
    images,
    removeImage,
    queue,
    pastes,
    previewPaste,
    expandPaste,
    removePaste,
    observe,
    clear,
  };
}

/** One handle with the space either side of it, matched literally rather than as a pattern. */
function spacedToken(token: string): RegExp {
  return new RegExp(` ?${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ?`);
}
