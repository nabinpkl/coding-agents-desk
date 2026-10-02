// Choosing a folder to register as a workspace.
//
// This replaces a `window.prompt` asking for an absolute path, which was a shortcut with two real
// costs: on a phone it asked a touch keyboard to type `/Users/...` correctly, and on either surface
// it made the reader hold the filesystem in their head rather than look at it.
//
// A browser cannot do this on its own -- nothing in the web platform hands a page an absolute
// directory path, `<input webkitdirectory>` included -- so the sidecar lists and creates and this
// draws. Both are confined to the home directory by the same route's reasoning, recorded in
// `workspaceBrowse.ts`: browsing can only ever show what already exists, so making a folder is the
// one act here that writes, and it needed a way in that could not walk out of the root.

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, CornerLeftUp, Folder, FolderPlus, Loader2, X } from "lucide-react";
import type { WorkspaceBrowseListing } from "@agentdesk/agent-feed-wire";

const ROW = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left outline-none"
  + " hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset";

export function WorkspacePicker({
  browse,
  createFolder,
  onChoose,
  onCancel,
  title = "Choose a project folder",
  confirmLabel = "Add this folder",
}: {
  browse: (path: string | null) => Promise<WorkspaceBrowseListing>;
  /** Makes a folder inside the directory on screen and answers with its listing, so the picker can
      stand in it. Refusing a name already taken is the sidecar's call, and its message is shown. */
  createFolder: (path: string, name: string) => Promise<WorkspaceBrowseListing>;
  onChoose: (path: string) => void;
  onCancel: () => void;
  /** What the reader is choosing FOR, since the same picker now serves the IDE and a new Bot. */
  title?: string;
  confirmLabel?: string;
}) {
  const [listing, setListing] = useState<WorkspaceBrowseListing | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The create form is its own row rather than another field on the footer: the footer says what
  // choosing this folder means, and a reader who cannot get to the folder they want needs a way to
  // make it without that decision changing under them.
  const [draft, setDraft] = useState<{ name: string; error: string | null; busy: boolean } | null>(null);

  const show = useCallback(
    (path: string | null) => {
      setLoading(true);
      setFailure(null);
      // A name being typed belongs to the directory it was typed in. Carrying it across a move
      // would create that folder somewhere the reader was not looking when they named it, which is
      // the one outcome a picker that shows where it is exists to prevent.
      setDraft(null);
      browse(path)
        .then(setListing)
        .catch((cause: unknown) =>
          setFailure(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setLoading(false));
    },
    [browse],
  );

  useEffect(() => show(null), [show]);

  /**
   * Make the folder the reader named, and stand in it.
   *
   * Into the new folder rather than staying put, because that is almost always what they meant: a
   * folder made to hold a project is where the project goes next, and the picker's only other act
   * is to add the folder being looked at. The sidecar answers with the new folder's listing, so
   * there is no second round trip and the path on screen is the resolved one.
   *
   * A failure keeps the listing, unlike a browse failure, which replaces the list: nothing about
   * where they are went wrong, so wiping it would throw away the position a retry needs.
   */
  const create = useCallback(() => {
    if (!listing || draft === null) return;
    const name = draft.name.trim();
    if (name === "" || draft.busy) return;
    setDraft({ ...draft, busy: true, error: null });
    createFolder(listing.path, name)
      .then((created) => {
        setDraft(null);
        setListing(created);
        setFailure(null);
      })
      .catch((cause: unknown) =>
        setDraft({
          name,
          error: cause instanceof Error ? cause.message : String(cause),
          busy: false,
        }));
  }, [createFolder, draft, listing]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl
        border border-border bg-background shadow-xl"
      >
        <header className="shrink-0 border-b border-border px-4 py-3">
          <h2 className="m-0 text-sm font-medium">{title}</h2>
          {/* The path is the answer to "where am I", so it stays visible while browsing rather
              than only appearing on the button. */}
          <p className="m-0 mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap font-mono
            text-xs text-muted-foreground"
          >
            {listing?.path ?? "…"}
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          {failure
            ? <p className="px-2 py-6 text-center text-sm text-destructive">{failure}</p>
            : (
              <>
                {listing?.parent
                  ? (
                    <button
                      type="button"
                      aria-label="Go up one folder"
                      onClick={() => show(listing.parent)}
                      className={`${ROW} text-muted-foreground`}
                    >
                      <CornerLeftUp className="size-4 shrink-0" />
                      Up one folder
                    </button>
                  )
                  : null}
                {listing?.entries.length === 0 && !loading
                  ? (
                    <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                      No folders in here. This one can still be chosen, or you can make one below.
                    </p>
                  )
                  : null}
                {listing?.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    aria-label={`Open ${entry.name}`}
                    onClick={() => show(entry.path)}
                    className={ROW}
                  >
                    <Folder className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                      {entry.name}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </>
            )}
        </div>

        {/* The create form, above the footer rather than inside it: the footer is where the two
            decisions about THIS folder live, and neither of them changes because a folder was made
            here -- so it should not look as if they did. */}
        {draft === null ? null : (
          <div className="shrink-0 border-t border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <label htmlFor="workspace-picker-new-folder" className="sr-only">New folder name</label>
              <input
                id="workspace-picker-new-folder"
                autoFocus
                value={draft.name}
                placeholder="Folder name"
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value, error: null })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    create();
                  }
                  // Escape abandons the folder rather than the picker: this row is what the reader
                  // opened a moment ago, and it is the only thing here Escape can be about.
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setDraft(null);
                  }
                }}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2
                  py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
              <button
                type="button"
                onClick={create}
                disabled={draft.busy || draft.name.trim() === ""}
                className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground
                  outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary
                  disabled:opacity-40"
              >
                {draft.busy ? "Creating…" : "Create"}
              </button>
              <button
                type="button"
                onClick={() => setDraft(null)}
                aria-label="Cancel creating a folder"
                className="flex size-8 shrink-0 items-center justify-center rounded-md
                  text-muted-foreground outline-none hover:bg-muted hover:text-foreground
                  focus-visible:ring-2 focus-visible:ring-primary"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            {/* The sidecar's reason, in its words: "that name is taken" is not something this
                component can invent, and a refusal the reader cannot read is a refusal they will
                try again the same way. */}
            {draft.error === null ? null : (
              <p role="alert" className="m-0 mt-2 text-xs text-destructive">{draft.error}</p>
            )}
          </div>
        )}

        <footer className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3">
          {loading ? <Loader2 aria-label="Loading" className="size-4 animate-spin" /> : null}
          {/* Before the spinner, so it is the first thing a thumb finds and it reads as the escape
              from a folder that is not there: browsing can only ever show what already exists. */}
          <button
            type="button"
            onClick={() => setDraft({ name: "", error: null, busy: false })}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3
              py-1.5 text-sm outline-none hover:bg-muted focus-visible:ring-2
              focus-visible:ring-primary"
          >
            <FolderPlus className="size-4" aria-hidden />
            New folder
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-1.5 text-sm outline-none
              hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary"
          >
            Cancel
          </button>
          {/* Adds the folder being LOOKED AT, not one selected in the list. Navigating into a
              folder is how you choose it, so there is no separate selection to get out of step
              with what the header says. */}
          <button
            type="button"
            disabled={!listing}
            onClick={() => listing && onChoose(listing.path)}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground
              outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary
              disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
