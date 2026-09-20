import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { ComposerImage } from "@/features/cli-input/useTmuxComposer";
import { ImageLightbox } from "@/features/image-viewer/ImageLightbox";

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
        <ImageLightbox
          title={`Image #${shown.id}`}
          url={shown.url}
          alt={`Image #${shown.id} in the composer`}
          onClose={() => setOpened(null)}
        >
          {/* Full width because it is the touch answer to the corner button: the reader got here
              by tapping the picture, which is the large target. */}
          {!disabled ? (
            <button
              type="button"
              onClick={() => {
                onRemove(shown.id);
                setOpened(null);
              }}
              className="min-h-11 w-full touch-manipulation rounded-lg border border-border text-sm font-medium text-muted-foreground outline-none transition-colors hover:border-destructive hover:text-destructive focus-visible:ring-2 focus-visible:ring-primary active:bg-muted"
            >
              Remove from the composer
            </button>
          ) : null}
        </ImageLightbox>
      ) : null}
    </>
  );
}
