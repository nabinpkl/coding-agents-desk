// The large modal a Bot's card opens for a look into its directory: its changes, or its code.
//
// A frame and nothing else. Both looks are a list on the left and a reading pane on the right,
// taken from the IDE; what they share with each other is only this -- the backdrop, the header
// with its close button, and the rule about events below -- so it is written once here.

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Stops an event at the dialog, for the reason given where it is attached. */
const stop = (event: React.SyntheticEvent): void => event.stopPropagation();

export function BotWideDialog({
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
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node || node.open) return;
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
  }, []);

  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className="fixed inset-0 z-60 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-2 text-foreground backdrop:bg-black/45 open:flex sm:p-4"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      // The dialog is portalled out of the card in the DOM, but React still bubbles its events
      // through the card, and the card's header starts a drag on any press that is not on a
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
