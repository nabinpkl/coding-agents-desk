/* The preview draft as stored: every change the reader has previewed on a page and not yet saved,
 * and whether preview was on when they last looked.
 *
 * In chrome.storage.local, per page, so it survives a reload, a closed tab and a browser restart;
 * only the reader's Discard deletes it. It is not an annotation (the server is the only home for
 * those), it is work in progress, the same as text typed into a field. Read back field by field
 * rather than cast: a draft from an older build that does not fit is dropped, not drawn. */
import type { ElementMetadata } from "../../../shared/annotation.ts";
import { CSS_PIXELS, STYLE_PROPERTIES, type StyleProperty } from "../../../shared/vocab.ts";

export interface DraftChange {
  selector: string;
  property: StyleProperty;
  /** The page's own computed value, before any preview. */
  from: string;
  to: string;
  /** The element as it was when first changed, so the annotation can be written even if it has gone. */
  meta: ElementMetadata;
}

export interface PreviewDraft {
  on: boolean;
  changes: DraftChange[];
}

const PREFIX = "previewDraft:";

/** One draft per page: the address without its fragment, which names a place on the page, not a page. */
export function draftKey(): string {
  return `${PREFIX}${location.origin}${location.pathname}${location.search}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readChange(v: unknown): DraftChange | null {
  if (!isRecord(v)) return null;
  const { selector, property, from, to, meta } = v;
  if (typeof selector !== "string" || selector === "") return null;
  const known = STYLE_PROPERTIES.find((p) => p === property);
  if (!known || typeof from !== "string" || typeof to !== "string" || !CSS_PIXELS.test(from) || !CSS_PIXELS.test(to)) return null;
  if (!isRecord(meta)) return null;
  return { selector, property: known, from, to, meta: meta as ElementMetadata };
}

export async function loadDraft(key: string): Promise<PreviewDraft> {
  const v: unknown = (await chrome.storage.local.get(key))[key];
  if (!isRecord(v) || !Array.isArray(v.changes)) return { on: false, changes: [] };
  return {
    on: v.on === true,
    changes: v.changes.map(readChange).filter((c): c is DraftChange => c !== null),
  };
}

/** Writes the draft, or removes the key when there is nothing left worth keeping. */
export async function storeDraft(key: string, draft: PreviewDraft): Promise<void> {
  if (!draft.on && draft.changes.length === 0) await chrome.storage.local.remove(key);
  else await chrome.storage.local.set({ [key]: draft });
}
