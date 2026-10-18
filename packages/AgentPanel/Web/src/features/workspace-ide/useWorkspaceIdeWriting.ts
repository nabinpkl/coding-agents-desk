// Everything between a keystroke and the bytes reaching disk.
//
// This is `WorkspaceIDEControllerEditing.swift`, and it is a separate file for the reason it was
// there: it is the only part of the IDE holding something a reader would mind losing. Its rules are
// all one rule -- nothing may throw away text that has not been written down -- and each of them is
// a case the Swift handled, listed here so the next reader does not have to rediscover why the code
// is more careful than it looks:
//
//  - a tab closing inside the autosave delay waits for its write instead of taking the text along;
//  - a conflicted tab refuses to close at all, because that close has nothing behind it;
//  - only one write per path is ever in flight, so a reader's own save cannot come back as somebody
//    else's edit;
//  - keystrokes landed during a write leave the file dirty against the revision that write made,
//    and re-schedule rather than waiting for another keystroke;
//  - resolving a conflict re-reads first, and writes against the revision it just fetched.

import { useCallback, useRef } from "react";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useUnmountEffect } from "@/hooks/useMountEffect";
import { useStateFor } from "@/hooks/useStateFor";
import type { WorkspaceOperation } from "@agentdesk/agent-feed-wire";
import type { OpenFile } from "@/features/workspace-ide/useWorkspaceIde";
import type { WorkspaceIdeClient } from "@/features/workspace-ide/workspaceIdeClient";
import { WorkspaceRequestError } from "@/features/workspace-ide/workspaceIdeClient";
import { removeDraft, storeDraft } from "@/features/workspace-ide/workspaceIdeDrafts";

/**
 * How long unsaved text rests before it is also kept in this tab's storage.
 *
 * Shorter than the autosave delay, because this is the thing that catches an edit the autosave has
 * not got to yet -- and a `sessionStorage` write is synchronous, so it is not free enough to do on
 * every keystroke of a large file.
 */
const DRAFT_DELAY_MS = 300;

/** How long an edit rests before it is written. Ported from the Swift's autosave delay. */
const AUTOSAVE_DELAY_MS = 900;

interface Options {
  client: WorkspaceIdeClient;
  workspaceId: string | null;
  /** Which workspace's requests are current, so an answer from the previous one is dropped. */
  generationRef: { readonly current: string };
  openFilesRef: { current: Record<string, OpenFile> };
  setOpenFiles: React.Dispatch<React.SetStateAction<Record<string, OpenFile>>>;
  setError: (message: string) => void;
  applyOperation: (operation: WorkspaceOperation) => void | Promise<void>;
  reload: (path: string) => void | Promise<void>;
}

export interface WorkspaceIdeWriting {
  edit(path: string, text: string): void;
  closePath(path: string): void;
  useHostVersion(path: string): void;
  keepMyVersion(path: string): void;
}

export function useWorkspaceIdeWriting({
  client,
  workspaceId,
  generationRef,
  openFilesRef,
  setOpenFiles,
  setError,
  applyOperation,
  reload,
}: Options): WorkspaceIdeWriting {
  /**
   * Paths with a write in flight, and paths whose tab should close once their write lands.
   *
   * The first is the Swift's `.writing` autosave phase: a second write must not start while one is
   * outstanding, because it would state the revision the first one is about to replace and conflict
   * with our own save. The second is `pendingClosePaths`: a tab with unsaved text stays until the
   * text is on disk.
   */
  // Neither set outlives the workspace they were taken against.
  const [scoped] = useStateFor(workspaceId, () => ({ writing: new Set<string>(), pendingClose: new Set<string>() }));
  const writingRef = useLatestRef(scoped.writing);
  const pendingCloseRef = useLatestRef(scoped.pendingClose);
  const draftTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /** Stop a pending draft write, and drop whatever is stored. The text is on disk or discarded. */
  const forgetDraft = useCallback((path: string) => {
    const timer = draftTimers.current.get(path);
    if (timer) clearTimeout(timer);
    draftTimers.current.delete(path);
    if (workspaceId) removeDraft(workspaceId, path);
  }, [workspaceId]);

  /** Keep this tab's unsaved text, after a rest, against the revision it was typed from. */
  const keepDraft = useCallback((path: string) => {
    if (!workspaceId) return;
    const existing = draftTimers.current.get(path);
    if (existing) clearTimeout(existing);
    draftTimers.current.set(path, setTimeout(() => {
      draftTimers.current.delete(path);
      const file = openFilesRef.current[path];
      if (!file || file.saveState === "clean") return;
      const kept = storeDraft(workspaceId, path, {
        text: file.text,
        baselineRevision: file.revision,
        updatedAt: Date.now(),
      });
      // The one storage failure worth saying out loud: the reader is relying on text being held
      // somewhere, and it is not.
      if (!kept) setError("This tab could not keep a copy of your unsaved changes.");
    }, DRAFT_DELAY_MS));
  }, [openFilesRef, setError, workspaceId]);

  useUnmountEffect(() => {
    for (const timer of draftTimers.current.values()) clearTimeout(timer);
    draftTimers.current.clear();
  });

  // Autosave. One timer per path, cleared when the path saves, closes or is superseded.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useUnmountEffect(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  });

  const cancelTimer = useCallback((path: string) => {
    const timer = timers.current.get(path);
    if (timer) clearTimeout(timer);
    timers.current.delete(path);
  }, []);

  /**
   * Write one file, stating the revision it was based on.
   *
   * The revision and text are arguments rather than reads of the current state, because the two
   * callers disagree about where they come from: an autosave takes whatever is on screen when its
   * timer fires, and resolving a conflict takes the text the reader kept against the revision that
   * was just fetched -- which the state has not been re-rendered with yet.
   */
  const writeNowRef = useRef<(path: string, revision: string, text: string) => void>(() => {});

  /** Rest an edit for `AUTOSAVE_DELAY_MS`, then write whatever is on screen by then. */
  const scheduleSave = useCallback((path: string) => {
    cancelTimer(path);
    timers.current.set(path, setTimeout(() => {
      timers.current.delete(path);
      const file = openFilesRef.current[path];
      if (!file || file.saveState !== "dirty") return;
      writeNowRef.current(path, file.revision, file.text);
    }, AUTOSAVE_DELAY_MS));
  }, [cancelTimer]);

  const writeNow = useCallback(async (path: string, revision: string, text: string) => {
    if (!workspaceId) return;
    // One write per path at a time. A second one would state the revision the first is about to
    // replace, so it would conflict with this reader's own save -- which reads to them as somebody
    // else having edited the file, and is what the Swift's `.writing` phase existed to prevent.
    if (writingRef.current.has(path)) return;
    writingRef.current.add(path);
    const generation = generationRef.current;
    setOpenFiles((current) => {
      const held = current[path];
      return held ? { ...current, [path]: { ...held, saveState: "saving" } } : current;
    });
    try {
      const outcome = await client.writeFile(workspaceId, path, revision, text);
      if (generation !== generationRef.current) return;
      // Decided from the ref rather than inside the updater, which React may run twice.
      const moved = (openFilesRef.current[path]?.text ?? text) !== text;
      setOpenFiles((current) => {
        const held = current[path];
        if (!held) return current;
        if (outcome.status === "conflict") {
          return { ...current, [path]: { ...held, saveState: "conflict" } };
        }
        return {
          ...current,
          [path]: {
            ...held,
            revision: outcome.written.revision,
            saveState: moved ? "dirty" : "clean",
          },
        };
      });
      // A conflict is one of the two states autosave will never rescue, so the text is kept
      // against the revision it was typed from rather than the one that beat it.
      if (outcome.status === "conflict") {
        keepDraft(path);
        return;
      }
      // Keystrokes landed while the write was in flight, so the file is dirty again against the
      // revision this write just produced. Without this it would sit dirty and unscheduled until
      // the reader typed once more.
      if (moved) {
        keepDraft(path);
        scheduleSave(path);
        return;
      }
      // On disk and identical, so there is nothing left for a draft to preserve.
      forgetDraft(path);
      if (pendingCloseRef.current.delete(path)) {
        setOpenFiles((current) => {
          const next = { ...current };
          delete next[path];
          return next;
        });
        void applyOperation({ type: "close", path });
      }
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setOpenFiles((current) => {
        const held = current[path];
        return held ? { ...current, [path]: { ...held, saveState: "dirty" } } : current;
      });
      pendingCloseRef.current.delete(path);
      // The other state autosave does not come back to: a failed write waits for the next
      // keystroke, so without this the text would have nothing behind it until then.
      keepDraft(path);
      setError(describe(cause, "The file could not be saved."));
    } finally {
      writingRef.current.delete(path);
    }
  }, [applyOperation, client, forgetDraft, keepDraft, openFilesRef, scheduleSave, setError, setOpenFiles, generationRef, writingRef, pendingCloseRef, workspaceId]);

  writeNowRef.current = (path, revision, text) => void writeNow(path, revision, text);

  const edit = useCallback((path: string, text: string) => {
    setOpenFiles((current) => {
      const file = current[path];
      if (!file) return current;
      // A conflicted file stays conflicted while it is edited: the reader has to resolve it, and
      // quietly clearing the flag on the next keystroke would lose that. It is also why no save is
      // scheduled here for one -- the write would conflict again against the same stale revision.
      if (file.saveState === "conflict") return current[path] === file
        ? { ...current, [path]: { ...file, text } }
        : current;
      return { ...current, [path]: { ...file, text, saveState: "dirty" } };
    });
    keepDraft(path);
    if (openFilesRef.current[path]?.saveState === "conflict") return;
    scheduleSave(path);
  }, [keepDraft, openFilesRef, scheduleSave]);

  const useHostVersion = useCallback((path: string) => {
    cancelTimer(path);
    pendingCloseRef.current.delete(path);
    // Dropped before the read, not after: the reader asked for the file on disk, and a draft left
    // in place would be restored over it by the very reload that is meant to discard it.
    forgetDraft(path);
    void reload(path);
  }, [cancelTimer, forgetDraft, reload]);

  /**
   * Keep the local text, re-based on whatever is on disk now.
   *
   * Re-reading first is what makes the next write succeed: the draft's revision is stale by
   * definition once a conflict has been reported, so keeping it would conflict again forever.
   *
   * The write is handed the fetched revision directly rather than left to the autosave timer. The
   * state it was just set into has not been re-rendered yet, so a save that read the current file
   * would read the stale revision -- and, because the file is still marked conflicted at that
   * moment, would decline to write at all.
   */
  const keepMyVersion = useCallback(async (path: string) => {
    if (!workspaceId) return;
    const retained = openFilesRef.current[path]?.text;
    if (retained === undefined) return;
    cancelTimer(path);
    try {
      const { file } = await client.readFile(workspaceId, path);
      setOpenFiles((current) => {
        const held = current[path];
        return held
          ? { ...current, [path]: { ...held, text: retained, revision: file.revision, saveState: "dirty" } }
          : current;
      });
      writeNowRef.current(path, file.revision, retained);
    } catch (cause) {
      setError(describe(cause, "Could not fetch the latest revision."));
    }
  }, [cancelTimer, client, workspaceId]);

  /**
   * Close a tab, but never before its text is on disk.
   *
   * The three cases are the Swift's (`WorkspaceIDEControllerNavigation.close`): a clean file closes
   * at once; a dirty one is written first and closes when that lands; a conflicted one refuses,
   * because closing it is the one action that would discard the reader's side of the conflict with
   * nothing to undo it.
   */
  const closePath = useCallback((path: string) => {
    const file = openFilesRef.current[path];
    if (!file || file.saveState === "clean") {
      cancelTimer(path);
      forgetDraft(path);
      setOpenFiles((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      void applyOperation({ type: "close", path });
      return;
    }
    if (file.saveState === "conflict") {
      setError("Resolve the file conflict before closing this tab.");
      return;
    }
    cancelTimer(path);
    pendingCloseRef.current.add(path);
    if (file.saveState === "dirty") writeNowRef.current(path, file.revision, file.text);
  }, [applyOperation, cancelTimer, forgetDraft, openFilesRef, setError]);


  return {
    edit,
    closePath,
    useHostVersion,
    keepMyVersion: useCallback((path: string) => void keepMyVersion(path), [keepMyVersion]),
  };
}

function describe(cause: unknown, fallback: string): string {
  return cause instanceof WorkspaceRequestError ? cause.message : fallback;
}
