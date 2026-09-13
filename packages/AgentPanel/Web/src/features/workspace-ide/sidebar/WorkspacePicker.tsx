// Choosing a folder to register as a workspace.
//
// This replaces a `window.prompt` asking for an absolute path, which was a shortcut with two real
// costs: on a phone it asked a touch keyboard to type `/Users/...` correctly, and on either surface
// it made the reader hold the filesystem in their head rather than look at it.
//
// A browser cannot do this on its own -- nothing in the web platform hands a page an absolute
// directory path, `<input webkitdirectory>` included -- so the sidecar lists and this draws. It is
// confined to the home directory by the route, for the reason recorded in `workspaceBrowse.ts`.

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, CornerLeftUp, Folder, Loader2 } from "lucide-react";
import type { WorkspaceBrowseListing } from "@agentdesk/agent-feed-wire";

const ROW = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left outline-none"
  + " hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset";

export function WorkspacePicker({
  browse,
  onChoose,
  onCancel,
}: {
  browse: (path: string | null) => Promise<WorkspaceBrowseListing>;
  onChoose: (path: string) => void;
  onCancel: () => void;
}) {
  const [listing, setListing] = useState<WorkspaceBrowseListing | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const show = useCallback(
    (path: string | null) => {
      setLoading(true);
      setFailure(null);
      browse(path)
        .then(setListing)
        .catch((cause: unknown) =>
          setFailure(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setLoading(false));
    },
    [browse],
  );

  useEffect(() => show(null), [show]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Choose a project folder"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl
        border border-border bg-background shadow-xl"
      >
        <header className="shrink-0 border-b border-border px-4 py-3">
          <h2 className="m-0 text-sm font-medium">Choose a project folder</h2>
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
                      No folders in here. This one can still be chosen.
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

        <footer className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3">
          {loading ? <Loader2 aria-label="Loading" className="size-4 animate-spin" /> : null}
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
            Add this folder
          </button>
        </footer>
      </div>
    </div>
  );
}
