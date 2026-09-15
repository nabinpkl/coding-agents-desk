import { useEffect, useRef, type ReactNode } from "react";
import { Minus, Plus, X } from "lucide-react";
import { useImageZoom } from "@/features/image-viewer/useImageZoom";

/** Every control on the header line: one size, one set of states, hover through disabled. */
const CONTROL_CLASS =
  "flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground";

/**
 * One image, as large as the viewport allows, and larger than that on demand.
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
  const zoom = useImageZoom(url);

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
      // The magnifier's keys, where every image viewer puts them. Escape is the dialog's own.
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "+" || event.key === "=") zoom.zoomIn();
        else if (event.key === "-" || event.key === "_") zoom.zoomOut();
        else if (event.key === "0") zoom.reset();
        else return;
        event.preventDefault();
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
          <span className="truncate font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            {title}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={zoom.zoomOut}
              disabled={zoom.isFit}
              aria-label="Zoom out"
              className={CONTROL_CLASS}
            >
              <Minus className="h-4 w-4" aria-hidden="true" />
            </button>
            {/* The number is the control: it says where the view is and puts it back. */}
            <button
              type="button"
              onClick={zoom.reset}
              disabled={zoom.isFit}
              aria-label="Reset zoom"
              className="min-w-14 rounded-lg px-2 py-1.5 font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) tabular-nums text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            >
              {Math.round(zoom.scale * 100)}%
            </button>
            <button
              type="button"
              onClick={zoom.zoomIn}
              disabled={!zoom.canZoomIn}
              aria-label="Zoom in"
              className={CONTROL_CLASS}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className={CONTROL_CLASS}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
        {/* Contained rather than cropped: this view exists to show what the picture actually is.
            Bounded rather than given the rest of the dialog, because an image far smaller than the
            screen would otherwise be blown up to fill it.

            The frame is what the magnified picture is seen through, so it clips rather than
            growing the dialog, and it owns the gestures: `touch-action: none` because a pinch and
            a drag in here are this view's, not the page's. */}
        <div
          ref={zoom.frameRef}
          {...zoom.frameHandlers}
          className={
            "flex touch-none items-center justify-center overflow-hidden rounded-lg " +
            (zoom.isFit ? "" : zoom.isMoving ? "cursor-grabbing " : "cursor-grab ")
          }
        >
          <img
            ref={zoom.imageRef}
            src={url}
            alt={alt}
            draggable={false}
            style={{ transform: zoom.transform, transformOrigin: "center" }}
            className={
              "block max-h-[80dvh] w-full origin-center select-none object-contain " +
              (zoom.isMoving ? "" : "transition-transform duration-150 motion-reduce:transition-none")
            }
          />
        </div>
        {children}
      </div>
    </dialog>
  );
}
