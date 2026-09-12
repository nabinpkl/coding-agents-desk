import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ComposerImage } from "@/features/cli-input/useTmuxComposer";

/**
 * The images a terminal composer is holding, above the field and inside its border.
 *
 * Where the pictures come from is the whole reason this is small: the images themselves live in a
 * table inside the Claude process, so what this can show is the bytes THIS browser sent, keyed to
 * the numbers that process gave them. An image somebody dropped into the pane directly has a token
 * and no picture, and is shown as its number rather than hidden -- the strip and the text must
 * never disagree about how many images are in the composer.
 *
 * Nothing here is revealed by hover. Half the readers of this panel are on a phone, where hover
 * does not exist and a control that appears on it is a control that is not there. So the remove
 * button is always visible, and the two actions are separated by size instead: the picture is the
 * large target and opens it, the small corner button removes it, and the opened view carries a
 * full-width Remove for anyone who would rather not aim at the corner.
 */
export function ComposerImageStrip({
  images,
  onRemove,
  disabled,
}: {
  images: readonly ComposerImage[];
  onRemove: (id: number) => void;
  disabled: boolean;
}) {
  const [opened, setOpened] = useState<number | null>(null);
  const shown = images.find((image) => image.id === opened) ?? null;

  // An image can leave the composer while its enlargement is open -- removed from the strip
  // behind it, or taken by a turn somebody submitted in the pane. Close rather than hold a
  // picture of something the composer is no longer carrying.
  useEffect(() => {
    if (opened !== null && shown === null) setOpened(null);
  }, [opened, shown]);

  if (images.length === 0) return null;

  return (
    <>
      {/* Room for the corner buttons, which hang past their picture on both sides. */}
      <ul className="flex flex-wrap gap-3 px-3 pt-3">
        {images.map((image) => (
          <li key={image.id} className="relative">
            {image.url === null ? (
              // Nothing to enlarge, so nothing to press. Named by its number, in the monospace
              // the panel uses for identifiers.
              <span
                className="flex h-14 w-14 items-center justify-center rounded-lg border border-border bg-muted/40 font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground"
                title={`Image #${image.id}, put into the terminal from somewhere else`}
              >
                {`#${image.id}`}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setOpened(image.id)}
                aria-label={`Open image #${image.id} larger`}
                className="block h-14 w-14 touch-manipulation overflow-hidden rounded-lg border border-border outline-none transition-[border-color,opacity] hover:border-primary focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary active:opacity-70"
              >
                <img src={image.url} alt="" className="h-full w-full object-cover" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onRemove(image.id)}
              disabled={disabled}
              aria-label={`Remove image #${image.id} from the composer`}
              // Always drawn, never revealed. Overlapping the corner so it costs the picture no
              // room, and sized for a thumb rather than for a cursor.
              className="absolute -right-2 -top-2 flex h-7 w-7 touch-manipulation items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm outline-none transition-colors hover:border-destructive hover:text-destructive focus-visible:ring-2 focus-visible:ring-primary active:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {shown?.url ? (
        <EnlargedComposerImage
          id={shown.id}
          url={shown.url}
          removable={!disabled}
          onRemove={() => {
            onRemove(shown.id);
            setOpened(null);
          }}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </>
  );
}

/**
 * One image, as large as the viewport allows.
 *
 * A native `<dialog>` for the same reasons every other dialog in this panel is one: Escape and the
 * backdrop come with it, and it is the top layer rather than a z-index somebody has to keep
 * winning. The Remove here is full width because it is the touch answer to the corner button --
 * the reader got here by tapping the picture, which is the large target.
 */
function EnlargedComposerImage({
  id,
  url,
  removable,
  onRemove,
  onClose,
}: {
  id: number;
  url: string;
  removable: boolean;
  onRemove: () => void;
  onClose: () => void;
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
      aria-label={`Image #${id}`}
      className="fixed inset-0 z-60 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-4 text-foreground backdrop:bg-black/70 open:flex"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col gap-3 rounded-xl border border-border bg-card p-3 shadow-2xl">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            {`Image #${id}`}
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
        <img
          src={url}
          alt={`Image #${id} in the composer`}
          className="max-h-[70dvh] w-full rounded-lg object-contain"
        />
        {removable ? (
          <button
            type="button"
            onClick={onRemove}
            className="min-h-11 w-full touch-manipulation rounded-lg border border-border text-sm font-medium text-muted-foreground outline-none transition-colors hover:border-destructive hover:text-destructive focus-visible:ring-2 focus-visible:ring-primary active:bg-muted"
          >
            Remove from the composer
          </button>
        ) : null}
      </div>
    </dialog>
  );
}
