import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * One image, as large as the viewport allows.
 *
 * A native `<dialog>` for the same reasons every other dialog in this panel is one: Escape and the
 * backdrop come with it, and it is the top layer rather than a z-index somebody has to keep
 * winning. That last part is why a thumbnail deep inside a virtualized, scrolling transcript row
 * can open one without being clipped by it.
 *
 * Mounted open: the caller renders it while something is opened and unmounts it to close, so there
 * is one owner of whether it is showing. `children` sit under the picture, for whatever the caller
 * can do with it -- the composer's Remove, and nothing at all in the feed.
 */
export function ImageLightbox({
  title,
  url,
  alt,
  onClose,
  children,
}: {
  /** The dialog's name, and the caption above the picture. */
  title: string;
  url: string;
  alt: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      className="fixed inset-0 z-60 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-4 text-foreground backdrop:bg-black/70 open:flex"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // React bubbles through the component tree, not the top layer, so a click in here would
        // otherwise reach whatever row or card the opener sits in.
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-4xl flex-col gap-3 rounded-xl border border-border bg-card p-3 shadow-2xl">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 touch-manipulation items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {/* Contained rather than cropped: this view exists to show what the picture actually is.
            Bounded rather than given the rest of the dialog, because an image far smaller than the
            screen would otherwise be blown up to fill it. */}
        <img src={url} alt={alt} className="max-h-[80dvh] w-full rounded-lg object-contain" />
        {children}
      </div>
    </dialog>
  );
}
