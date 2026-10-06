/* A page's preview: the draft of changes the reader is trying out, drawn on the page while preview is
 * on, plus the one change the comment form is showing while it is open.
 *
 * The draft is written to storage on every change and only Discard deletes it, so the work survives
 * a reload, a closed tab and a restart. Leaving preview hides the changes and keeps them. Changes
 * that were saved as annotations leave the draft but stay drawn until preview is left, so the reader
 * still sees what they just sent. */
import { draftKey, loadDraft, storeDraft, type DraftChange, type PreviewDraft } from "./previewDraft.ts";
import { createPreviewSheet, type PreviewRule } from "./previewSheet.ts";

export interface PreviewSession {
  on(): boolean;
  changes(): readonly DraftChange[];
  find(selector: string): DraftChange | undefined;
  savedCount(): number;
  comparing(): boolean;
  /** What went wrong drawing or storing the draft, said for the reader, or "" when nothing did. */
  problem(): string;
  /** Reads the draft for the page the tab is on now, and draws it if preview was on. */
  load(): Promise<void>;
  setOn(on: boolean): void;
  /** Adds the change, or replaces the one already there for the same selector and property. */
  put(change: DraftChange): void;
  remove(selector: string): void;
  discard(): void;
  /** Moves a selector's changes out of the draft once they are annotations; they stay drawn until preview is left. */
  markSaved(selector: string): void;
  /** Hides every change while the reader holds compare. */
  compare(holding: boolean): void;
  /** The comment form's own change, drawn whether or not preview is on and never stored. */
  setTransient(rule: PreviewRule | null): void;
  /** Runs `read` against the page with nothing previewed. */
  original<T>(read: () => T): T;
  /** Runs `read` with everything drawn except this selector's draft changes and the form's own. */
  without<T>(selector: string, read: () => T): T;
}

function toRule(c: DraftChange): PreviewRule {
  return { selector: c.selector, property: c.property, value: c.to };
}

export function createPreviewSession(onUpdate: () => void): PreviewSession {
  const sheet = createPreviewSheet();
  let key = draftKey();
  let draft: PreviewDraft = { on: false, changes: [] };
  let saved: DraftChange[] = [];
  let transient: PreviewRule | null = null;
  let holding = false;
  let refused: string[] = [];
  let storeError = "";
  // Writes land in the order they were made: a slow write must not overwrite a newer one.
  let writes: Promise<void> = Promise.resolve();

  /**
   * What is drawn, in cascade order: saved changes first, so a new edit of an element that was just
   * saved draws over it, then the draft, then the comment form's own change. `except` leaves out one
   * selector's draft and form changes, to measure what the element shows without them.
   */
  function rules(except?: string): PreviewRule[] {
    const kept = draft.on ? [...saved, ...draft.changes.filter((c) => c.selector !== except)].map(toRule) : [];
    return transient && transient.selector !== except ? [...kept, transient] : kept;
  }

  function draw(): void {
    refused = sheet.draw(rules());
  }

  function persist(): void {
    const snapshot: PreviewDraft = { on: draft.on, changes: [...draft.changes] };
    const at = key;
    writes = writes
      .then(() => storeDraft(at, snapshot))
      .then(
        () => {
          storeError = "";
        },
        (e: unknown) => {
          storeError = `The draft could not be kept: ${e instanceof Error ? e.message : String(e)}`;
          onUpdate();
        },
      );
  }

  function changed(): void {
    draw();
    persist();
    onUpdate();
  }

  return {
    on: () => draft.on,
    changes: () => draft.changes,
    find: (selector) => draft.changes.find((c) => c.selector === selector),
    savedCount: () => saved.length,
    comparing: () => holding,
    problem() {
      if (storeError) return storeError;
      if (refused.length > 0) return `${refused.length} change${refused.length === 1 ? "" : "s"} could not be drawn on this page: ${refused.join(", ")}`;
      return "";
    },
    async load() {
      key = draftKey();
      saved = [];
      try {
        draft = await loadDraft(key);
        storeError = "";
      } catch (e) {
        draft = { on: false, changes: [] };
        storeError = `The draft could not be read: ${e instanceof Error ? e.message : String(e)}`;
      }
      draw();
      onUpdate();
    },
    setOn(on) {
      draft = { ...draft, on };
      if (!on) saved = [];
      changed();
    },
    put(change) {
      const others = draft.changes.filter((c) => c.selector !== change.selector || c.property !== change.property);
      draft = { ...draft, changes: [...others, change] };
      changed();
    },
    remove(selector) {
      draft = { ...draft, changes: draft.changes.filter((c) => c.selector !== selector) };
      changed();
    },
    discard() {
      draft = { ...draft, changes: [] };
      changed();
    },
    markSaved(selector) {
      saved = [...saved, ...draft.changes.filter((c) => c.selector === selector)];
      draft = { ...draft, changes: draft.changes.filter((c) => c.selector !== selector) };
      changed();
    },
    compare(on) {
      if (holding === on) return;
      holding = on;
      sheet.setShown(!on);
      onUpdate();
    },
    setTransient(rule) {
      transient = rule;
      draw();
    },
    original: (read) => sheet.measureWith([], read),
    without: (selector, read) => sheet.measureWith(rules(selector), read),
  };
}
