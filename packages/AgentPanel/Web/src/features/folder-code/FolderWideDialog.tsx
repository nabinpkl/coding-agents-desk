// The large modal a look into a folder opens in: a Bot's directory from its card, an arena run's
// folder or a contestant's worktree from the arena.
//
// A frame and nothing else: the backdrop, the header with its close button, and the rule about
// events below. What goes inside is `FolderCodeDialog`'s, which is already long enough carrying the
// IDE's panes without the frame as well.

import { X } from "lucide-react";
import { type ReactNode } from "react";
import { createPortal } from "react-dom";
import { modalWhileMounted } from "@/hooks/dom/refCallbacks";

/** Stops an event at the dialog, for the reason given where it is attached. */
const stop = (event: React.SyntheticEvent): void => event.stopPropagation();

export function FolderWideDialog({
  titleId,
  title,
  subtitle,
  closeLabel,
  error,
  onClose,
  children,
}: {
  /** The heading's id, which names the dialog. Unique per kind of look. */
  titleId: string;
  title: string;
  subtitle: ReactNode;
  closeLabel: string;
  /** Why the content may be out of date, shown over it rather than instead of it. */
  error: string | null;
  onClose: () => void;
  children: ReactNode;
}) {
  return createPortal(
    <dialog
      ref={modalWhileMounted}
      aria-labelledby={titleId}
      className="fixed inset-0 z-60 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-2 text-foreground backdrop:bg-black/45 open:flex sm:p-4"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      // The dialog is portalled out of whatever opened it in the DOM, but React still bubbles its
      // events through it, and a Bot card's header starts a drag on any press that is not on a
      // button. A press on the content would otherwise pick the whole Bot up.
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={stop}
    >
      <div className="flex h-full max-h-[48rem] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-border py-2 pr-2 pl-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-base font-semibold">
              {title}
            </h2>
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            title="Close"
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        {error ? (
          <p role="alert" className="m-0 shrink-0 border-b border-border px-4 py-1.5 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {children}
      </div>
    </dialog>,
    document.body,
  );
}

/** The narrow-screen way back from the reading pane to the list, hidden where both fit. */
export const BACK_TO_LIST = "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70 md:hidden";
