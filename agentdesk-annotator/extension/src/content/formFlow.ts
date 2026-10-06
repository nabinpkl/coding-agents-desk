/* The form's three jobs: annotate one picked thing (a comment, with a font size shown only while the
 * form is open), change an element in the preview (an edit that goes into the draft and stays), and
 * save the whole preview draft as annotations, one per element. */
import type { Annotation, ElementMetadata, NewAnnotation, StyleChange, Tag } from "../../../shared/annotation.ts";
import { STYLE_PROPERTY_LABELS } from "../../../shared/vocab.ts";
import type { HttpMethod, Result } from "../messages.ts";
import type { Shot } from "./capture.ts";
import { clampFontSize, computedFontSize, cssPixels } from "./fontSize.ts";
import type { Panel } from "./panel.ts";
import { describeElement } from "./picker.ts";
import type { DraftChange } from "./previewDraft.ts";
import type { PreviewSession } from "./previewSession.ts";

type Region = NonNullable<ElementMetadata["region"]>;

/**
 * A font size being changed from the form. `from` is the page's own size, `base` the size the element
 * shows without this change (a previewed parent can already have moved it), and `own` this change's
 * size, if it has one. `keep` puts the change into the preview draft; otherwise it lasts only as long
 * as the comment form.
 */
interface SizeEdit {
  selector: string;
  from: number;
  base: number;
  own: number | null;
  meta: ElementMetadata;
  keep: boolean;
}

function sizeChange(edit: SizeEdit): StyleChange | null {
  if (edit.own === null || cssPixels(edit.own) === cssPixels(edit.from)) return null;
  return { property: "font-size", from: cssPixels(edit.from), to: cssPixels(edit.own) };
}

export function changeText(c: StyleChange): string {
  return `${STYLE_PROPERTY_LABELS[c.property]} ${c.from} \u2192 ${c.to}`;
}

export function matchCount(selector: string): number {
  try {
    return document.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

export interface FormFlowDeps {
  session: PreviewSession;
  panel(): Panel | null;
  call<T>(method: HttpMethod, path: string, body?: unknown): Promise<Result<T>>;
  /** Puts an annotation the server returned into the list. */
  replace(a: Annotation): void;
  render(): void;
  uploadShot(a: Annotation, shot: Shot): Promise<void>;
  /** Sends what was just saved; a send that fails is reported on its items. */
  sendSaved(ids: number[], to: string): Promise<void>;
  /** The form opened or closed, so the region picker can arm or stand down. */
  formChanged(): void;
}

export interface FormFlow {
  /** `target` is what the form is about, in viewport coordinates. */
  openComment(el: Element, shot: Shot | null, region: Region | null, target: DOMRect): void;
  openEditor(el: Element): void;
  openBatch(): void;
  setFontSize(px: number | null): void;
  cancelForm(): void;
  /** The form's primary action, whichever form is open. */
  save(text: string, tag: Tag, to: string): void;
  variant(): "comment" | "edit" | "batch" | null;
  /** The selector the editor is changing, or null when the editor is not open. */
  editing(): string | null;
}

export function createFormFlow(deps: FormFlowDeps): FormFlow {
  const { session } = deps;
  /** The element as the page's own code draws it, before any preview changed its size or its box. */
  let pendingMeta: ElementMetadata | null = null;
  let pendingShot: Shot | null = null;
  let pendingRegion: Region | null = null;
  let sizeEdit: SizeEdit | null = null;
  let formVariant: "comment" | "edit" | "batch" | null = null;

  function matchNote(selector: string): string {
    const n = matchCount(selector);
    return n > 1 ? `${selector}  ·  applies to ${n} elements` : selector;
  }

  /** Annotates one picked element or region. A container offers its font size, shown only while the form is open. */
  function openComment(el: Element, shot: Shot | null, region: Region | null, target: DOMRect): void {
    closeFormState();
    formVariant = "comment";
    pendingShot = shot;
    pendingRegion = region;
    pendingMeta = session.original(() => describeElement(el));
    const selector = pendingMeta.selector ?? "";
    // A region is about an area, and its anchor is only the element that happens to contain it, so
    // only a picked container offers a size to change.
    const from = region || !selector ? null : session.original(() => computedFontSize(el));
    const base = computedFontSize(el) ?? from;
    sizeEdit = from === null || base === null ? null : { selector, from, base, own: null, meta: pendingMeta, keep: false };
    const detail = region ? `${region.width} \u00d7 ${region.height} in ${selector || "?"}` : matchNote(selector || "?");
    deps.panel()?.openForm({
      variant: "comment",
      region: Boolean(region),
      detail: shot ? `${detail}  +  screenshot` : detail,
      fontSize: sizeEdit ? sizeEdit.base : null,
      target,
    });
    deps.formChanged();
  }

  /** Opens the preview editor on an element: a change made there goes into the draft and stays. */
  function openEditor(el: Element): void {
    const meta = session.original(() => describeElement(el));
    const selector = meta.selector;
    const from = session.original(() => computedFontSize(el));
    if (!selector || from === null) return;
    closeFormState();
    formVariant = "edit";
    const existing = session.find(selector);
    const base = session.without(selector, () => computedFontSize(el)) ?? from;
    sizeEdit = {
      selector,
      from: existing ? parseFloat(existing.from) : from,
      base,
      own: existing ? parseFloat(existing.to) : null,
      meta: existing?.meta ?? meta,
      keep: true,
    };
    deps.panel()?.openForm({ variant: "edit", detail: matchNote(selector), fontSize: sizeEdit.own ?? base, target: el.getBoundingClientRect() });
    if (existing) deps.panel()?.showFontSize(sizeEdit.own ?? base, sizeChange(sizeEdit));
    deps.formChanged();
  }

  function openBatch(): void {
    const groups = changesByElement();
    if (groups.length === 0) return;
    closeFormState();
    formVariant = "batch";
    const n = session.changes().length;
    deps.panel()?.openForm({
      variant: "batch",
      detail: `${n} change${n === 1 ? "" : "s"} on ${groups.length} element${groups.length === 1 ? "" : "s"}, saved as one annotation each`,
      count: groups.length,
    });
    deps.formChanged();
  }

  function setFontSize(px: number | null): void {
    const edit = sizeEdit;
    if (!edit) return;
    edit.own = px === null ? null : clampFontSize(px);
    const change = sizeChange(edit);
    // Back at the page's own size is no change at all, so nothing is drawn or kept for it.
    if (!change) edit.own = null;
    if (edit.keep) {
      if (change) session.put({ selector: edit.selector, ...change, meta: edit.meta });
      else session.remove(edit.selector);
    } else {
      session.setTransient(change ? { selector: edit.selector, property: change.property, value: change.to } : null);
    }
    deps.panel()?.showFontSize(edit.own ?? edit.base, change);
  }

  /** Forgets what the open form was about, and takes away the comment form's own unsaved size. */
  function closeFormState(): void {
    session.setTransient(null);
    sizeEdit = null;
    pendingMeta = null;
    pendingShot = null;
    pendingRegion = null;
    formVariant = null;
  }

  /** Closing the form. A comment form's size goes with it; an edit was made into the draft and stays there. */
  function cancelForm(): void {
    closeFormState();
    deps.panel()?.closeForm();
    deps.formChanged();
  }

  function save(text: string, tag: Tag, to: string): void {
    if (formVariant === "edit") cancelForm();
    else if (formVariant === "batch") void saveBatch(text, tag, to);
    else if (formVariant === "comment") void saveComment(text, tag, to);
  }

  async function saveComment(text: string, tag: Tag, to: string): Promise<void> {
    const panel = deps.panel();
    if (!panel || !pendingMeta) return;
    if (!text) {
      panel.setFormError("Write what is wrong first.");
      return;
    }
    const change = sizeEdit ? sizeChange(sizeEdit) : null;
    const metadata: ElementMetadata = {
      ...pendingMeta,
      ...(pendingRegion ? { region: pendingRegion } : {}),
      ...(change ? { styleChanges: [change] } : {}),
    };
    const input: NewAnnotation = { url: location.href, title: document.title, text, tag, metadata };
    panel.setFormBusy(true);
    panel.setFormError("");
    const created = await deps.call<Annotation>("POST", "/api/v1/annotations", input);
    if (!created.ok) {
      panel.setFormBusy(false);
      panel.setFormError(created.kind === "signed-out" ? "Signed out: sign in from the list, then Save again." : `Not saved: ${created.error}`);
      deps.render();
      return;
    }
    deps.replace(created.data);
    const shot = pendingShot;
    panel.setFormBusy(false);
    cancelForm();
    deps.render();
    // The screenshot lands before the send, so a session that reads the annotation at once finds it.
    if (shot) await deps.uploadShot(created.data, shot);
    if (to) await deps.sendSaved([created.data.id], to);
  }

  /**
   * Saves every previewed change as annotations, one per element, each carrying the reader's note.
   * A change leaves the draft only once its annotation exists, so a save that stops partway leaves
   * the rest in the draft and the note in its field.
   */
  async function saveBatch(note: string, tag: Tag, to: string): Promise<void> {
    const panel = deps.panel();
    if (!panel) return;
    const groups = changesByElement();
    panel.setFormBusy(true);
    panel.setFormError("");
    const ids: number[] = [];
    let failure = "";
    for (const changes of groups) {
      const lines = changes.map(changeText).join("\n");
      const metadata: ElementMetadata = { ...changes[0]!.meta, styleChanges: changes.map(({ property, from, to }) => ({ property, from, to })) };
      const input: NewAnnotation = { url: location.href, title: document.title, text: note ? `${lines}\n\n${note}` : lines, tag, metadata };
      const created = await deps.call<Annotation>("POST", "/api/v1/annotations", input);
      if (!created.ok) {
        failure = created.kind === "signed-out" ? "signed out: sign in from the list, then Save again" : created.error;
        break;
      }
      deps.replace(created.data);
      ids.push(created.data.id);
      session.markSaved(changes[0]!.selector);
    }
    panel.setFormBusy(false);
    if (failure) {
      const left = groups.length - ids.length;
      panel.setBatchCount(left);
      panel.setFormError(`Saved ${ids.length} of ${groups.length}; ${left} still in the draft: ${failure}`);
    } else {
      cancelForm();
    }
    deps.render();
    if (to && ids.length > 0) await deps.sendSaved(ids, to);
  }

  /** The draft's changes, one list per element, in the order they were first made. */
  function changesByElement(): DraftChange[][] {
    const groups = new Map<string, DraftChange[]>();
    for (const c of session.changes()) groups.set(c.selector, [...(groups.get(c.selector) ?? []), c]);
    return [...groups.values()];
  }

  return {
    openComment,
    openEditor,
    openBatch,
    setFontSize,
    cancelForm,
    save,
    variant: () => formVariant,
    editing: () => (formVariant === "edit" ? (sizeEdit?.selector ?? null) : null),
  };
}
