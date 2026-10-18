// Taking an image by dropping it on a session, and saying so while it is over one.
//
// This lives apart from `SessionView` because the box a reader aims at is not the one `SessionView`
// draws. On the canvas a session is a CARD: a titlebar with the name on it, and the session's body
// underneath. `SessionView` is only the body, and only while the card is open -- so a reader
// dragging a file at the name, or at a collapsed card, was aiming at a box with no drop handling on
// it at all. Same shape as `controlsHost` and `tasksHost`: the session publishes what it can do,
// and whichever surface owns the box installs it.
//
// Two things here were measured rather than reasoned, because both were wrong the obvious way.
//
// The indication used to be `ring-2 ring-primary ring-inset` on `SessionView`'s own root, and it
// was drawn every time -- the class is live in this Tailwind (4.3.3 compiles `ring-inset` to
// `--tw-ring-inset: inset`, not a v3 leftover). An inset box-shadow paints above the element's own
// background and BELOW its descendants, and that root's first child is the transcript at
// `flex-1 ... bg-background`, flush to three edges. So the ring was painted and then covered
// everywhere except the strip under the composer. Screenshotted, in both shapes. An overlay is the
// fix rather than a louder ring: nothing paints over the last child.
//
// A target that cannot accept still takes the event. Without `preventDefault` on `dragover` no
// `drop` fires at all -- measured, `dragenter` and `dragover` arrive with `Files` in `types` and
// `drop` never comes -- and the file is then the browser's to handle rather than this page's.
// Refusing is therefore an act, not an absence: prevent the default, say no with `dropEffect`, and
// swallow it. `dropEffect = "none"` cancels the drop so `drop` does not fire, and `dragleave` fires
// in its place (measured, both branches in one run), which is what clears the overlay again.

import { useCallback, useState, type DragEvent } from "react";

/** What a surface spreads onto the box it wants to be the drop target. */
export interface FileDropProps<T extends HTMLElement> {
  onDragOver: (event: DragEvent<T>) => void;
  onDragLeave: (event: DragEvent<T>) => void;
  onDrop: (event: DragEvent<T>) => void;
}

/**
 * Makes one box the drop target for a session's images.
 *
 * `accept` null means this session cannot take one right now -- no mirrored composer, or a card
 * whose body is not even mounted. The handlers stay installed either way, which is the whole point:
 * a target that disappears when it cannot help does not refuse the file, it hands it to the browser.
 */
export function useFileDropTarget<T extends HTMLElement>(
  accept: ((files: readonly File[]) => void) | null,
): { dragging: boolean; dropProps: FileDropProps<T> } {
  const [dragging, setDragging] = useState(false);

  const onDragOver = useCallback(
    (event: DragEvent<T>) => {
      // Files only. A reader dragging a selection or a link across the canvas is not offering this
      // session anything, and lighting every card up for it would make the indication mean nothing.
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = accept === null ? "none" : "copy";
      setDragging(true);
    },
    [accept],
  );

  // Only when the pointer has actually left the box. `dragleave` also fires when it crosses onto a
  // child -- the transcript, the bands, the field -- and dropping the overlay there makes it
  // flicker over exactly the area somebody is aiming at.
  const onDragLeave = useCallback((event: DragEvent<T>) => {
    const to = event.relatedTarget;
    if (to instanceof Node && event.currentTarget.contains(to)) return;
    setDragging(false);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<T>) => {
      event.preventDefault();
      setDragging(false);
      // Reached only while accepting: a refusing target sets `dropEffect` to none, and the drop is
      // cancelled before this. Guarded anyway, because that is a browser's promise rather than ours.
      if (accept === null) return;
      accept([...event.dataTransfer.files]);
    },
    [accept],
  );

  return { dragging, dropProps: { onDragOver, onDragLeave, onDrop } };
}

/**
 * What the reader sees while a file is over the box.
 *
 * The last child of a `relative` box and `pointer-events-none`, which are both load-bearing. Last
 * so nothing paints over it, which is the failure this replaces. Transparent to the pointer so the
 * box underneath keeps receiving `dragover` -- an overlay that took the events would become the
 * `dragleave` target the moment it appeared, and blink itself off and on under the cursor.
 *
 * `refusal` is the message when this session cannot take the file, and null while it can. It is the
 * caller's sentence rather than one written here, because only the surface knows WHY: a collapsed
 * card can be opened, and a session with no composer to paste into cannot be helped by opening it.
 */
export function FileDropOverlay({
  dragging,
  refusal,
  message = "Drop to add to the composer",
}: {
  dragging: boolean;
  refusal: string | null;
  /**
   * What the overlay says while accepting. The default names the composer because every other
   * caller drops into one; a surface whose drop lands somewhere else -- a bare pane taking the
   * path as text -- says where instead.
   */
  message?: string;
}) {
  if (!dragging) return null;
  const accepting = refusal === null;
  return (
    <div
      // Not `aria-live`: this is a pointer affordance for a gesture only a pointer can make, and a
      // reader who cannot make it should not be read a message about it. The file picker beside the
      // composer is the path that does not need a drag.
      aria-hidden
      // The ring is the accept signal and its ABSENCE is the refusal, rather than two rings in two
      // colours. This palette is neutral -- `--primary` is near-black on the light ground and
      // near-white on the dark one, `--border` is a hairline on both -- so a second ring would have
      // to be read against the first to mean anything, and a refusal is not something to squint at.
      // Both scrims come from a token that FLIPS with the theme -- `--primary` here, `--foreground`
      // there -- so neither disappears into the card behind it. `bg-background/70` did exactly
      // that: on both themes `--background` and `--card` are within 0.02 lightness of each other.
      className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg ${
        accepting ? "bg-primary/10 ring-2 ring-primary ring-inset" : "bg-foreground/15"
      }`}
    >
      <span
        // Wraps rather than truncates. A card on this canvas is about 250px wide and the refusals
        // are sentences, so `truncate` here reads "This session has no com..." -- an indication
        // that has to be guessed at is the thing this whole file exists to stop. Two lines fit an
        // open card; a closed one is a single row, which is why its message is short enough to be
        // one line rather than trusted to fit.
        className={`mx-3 rounded-lg border border-border bg-card px-3 py-1.5 text-center text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium shadow-lg ${
          accepting ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        {refusal ?? message}
      </span>
    </div>
  );
}
