// Text a reader has typed and the file on disk does not have yet.
//
// Autosave writes an ordinary edit within a second, so most unsaved text needs no home at all. Two
// states are not ordinary, and both are unbounded in time rather than a second wide: a **conflicted
// file never autosaves**, because the write would clobber whoever moved first, and a **failed write
// is not retried** until the next keystroke. Between those and the reader resolving them, the text
// exists in React state and nowhere else -- and a Vite save discards React state many times an hour.
//
// `sessionStorage`, not `localStorage`, and the reason is not style:
//
//  - **It is private to one tab**, which is what a half-typed edit is. Two tabs open on one file
//    each keep their own; `localStorage` would have them overwrite each other silently.
//  - **Its quota is its own.** Measured 2026-09-10 at the dev origin: 4MB stored in `sessionStorage`
//    while `localStorage` already held 4MB, and an ordinary preference write still succeeded
//    alongside both. That matters because the text cap is 4MB, so one draft of a file at the limit
//    would take the whole of `localStorage` -- and every other thing the panel remembers shares
//    that, and swallows its own write failures by house rule. The reader's panel would quietly stop
//    remembering its arrangement because one large file was open.
//  - **It survives a reload**, which is the threat, and dies with the tab, which is the cleanup.
//    A draft cannot outlive the tab that typed it, so there is no long tail to evict.
//
// This is `WorkspaceIDEFileDraftStore`, which kept the same three fields for the same reason. What
// it is not is a second source of truth for the file: a draft exists only while the file differs
// from disk, and is removed the moment they agree.

/** One file's unsaved text, and what it was typed against. */
export interface WorkspaceDraft {
  text: string;
  /**
   * The revision the reader was editing from.
   *
   * The whole point of the record. On restore it is compared with what is on disk now: equal means
   * the draft is simply unsaved, and different means the file moved underneath it and the reader
   * has a conflict to resolve. Without it a restore could only offer the text, having lost the fact
   * that there was ever a divergence.
   */
  baselineRevision: string;
  /** Milliseconds since the epoch, used to decide which draft to evict when the quota is reached. */
  updatedAt: number;
}

const PREFIX = "agent-panel.workspace-ide.draft.";

/**
 * The key for one draft.
 *
 * A NUL joins the two parts because it is the one character neither can contain -- the sidecar
 * refuses an embedded NUL before a path reaches a syscall -- so no two (workspace, path) pairs can
 * collide on one key. Written as an escape rather than as a literal byte: a raw NUL in the source
 * makes git treat this TypeScript file as binary, which costs every diff and review of it.
 *
 * Exported so a test names a key the same way the code does rather than spelling one out and
 * quietly asserting against a key that was never written.
 */
export function draftKey(workspaceId: string, path: string): string {
  return `${PREFIX}${workspaceId}\u0000${path}`;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    // A container with storage disabled. The reader keeps their text for this page's lifetime.
    return null;
  }
}

/** Every draft key currently stored, newest last. */
function draftKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  return keys.sort((left, right) => stampOf(store, left) - stampOf(store, right));
}

function stampOf(store: Storage, key: string): number {
  const draft = decode(store.getItem(key));
  return draft?.updatedAt ?? 0;
}

/**
 * Validate on the way in rather than casting.
 *
 * A hand-edited or half-written record must become "no draft", not a draft whose text is
 * `undefined` -- which would render as the string "undefined" in the editor and then be saved.
 */
function decode(raw: string | null): WorkspaceDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceDraft>;
    if (typeof parsed.text !== "string") return null;
    if (typeof parsed.baselineRevision !== "string") return null;
    const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0;
    return { text: parsed.text, baselineRevision: parsed.baselineRevision, updatedAt };
  } catch {
    return null;
  }
}

export function loadDraft(workspaceId: string, path: string): WorkspaceDraft | null {
  const store = storage();
  if (!store) return null;
  try {
    return decode(store.getItem(draftKey(workspaceId, path)));
  } catch {
    return null;
  }
}

/**
 * Keep a draft, evicting older ones rather than failing if the quota is reached.
 *
 * Returns whether the text is now preserved. The caller is told rather than the failure being
 * swallowed: a draft that could not be written is the one case where the reader is relying on
 * something that is not there, so it has to be able to say so.
 */
export function storeDraft(workspaceId: string, path: string, draft: WorkspaceDraft): boolean {
  const store = storage();
  if (!store) return false;
  const key = draftKey(workspaceId, path);
  const record = JSON.stringify(draft);
  for (;;) {
    try {
      store.setItem(key, record);
      return true;
    } catch {
      // Oldest first, and never this file's own draft -- dropping the record we are here to write
      // would loop.
      const evictable = draftKeys(store).filter((candidate) => candidate !== key);
      if (evictable.length === 0) return false;
      try {
        store.removeItem(evictable[0]!);
      } catch {
        return false;
      }
    }
  }
}

export function removeDraft(workspaceId: string, path: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(draftKey(workspaceId, path));
  } catch {
    // Nothing to do: the draft outlives its usefulness by one tab at most.
  }
}

export type DraftReconciliation =
  | { state: "none" }
  | { state: "identical" }
  | { state: "unsaved"; text: string }
  | { state: "conflict"; text: string };

/**
 * What a stored draft means once the file on disk has been read again.
 *
 * The four answers are the whole lifecycle:
 *
 *  - **none**: nothing was kept, so the file is whatever disk says.
 *  - **identical**: the draft says what disk already says. It was saved by someone, or by this
 *    reader before the reload. Nothing is unsaved, so the draft is stale and goes.
 *  - **unsaved**: the file has not moved since the draft was typed, so this is simply text that
 *    had not been written yet. It comes back dirty and autosave takes it from there.
 *  - **conflict**: the file moved underneath the draft. The reader is shown their text and has to
 *    choose, which is the state they were in before the reload.
 */
export function reconcileDraft(
  draft: WorkspaceDraft | null,
  diskText: string,
  diskRevision: string,
): DraftReconciliation {
  if (!draft) return { state: "none" };
  if (draft.text === diskText) return { state: "identical" };
  if (draft.baselineRevision === diskRevision) return { state: "unsaved", text: draft.text };
  return { state: "conflict", text: draft.text };
}
