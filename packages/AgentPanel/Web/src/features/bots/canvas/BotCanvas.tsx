import type { BotView } from "@agentdesk/agent-feed-wire";
import { CanvasPlaceholder } from "@/features/bots/cards/canvasNotices";
import { type BotCommandError } from "@/features/bots/cards/botCanvasCards";
import { BotCanvasList } from "@/features/bots/cards/BotCanvasList";
import type { ComponentProps } from "react";
import { PanelErrorBoundary } from "@/app/PanelErrorBoundary";
import type { MachineError } from "@/features/bots/useBots";

// Re-exported because this is the canvas's entry point: the app imports the surface and the shape
// of a failure from one name, and the parts moving out did not move that.
export type { BotCommandError };

/**
 * The Bots put on the canvas, with all of their curated sessions, in one scroll.
 *
 * The Bots view answers "what is this one Bot working on" and pays for it by making the other Bots
 * invisible: picking one is the only way to see anything, so comparing two means switching twice
 * and remembering the first. This is the same roster with that pick removed -- the reader scrolls
 * instead of switching, which is the whole point of it existing beside the tab it came from.
 *
 * All of them by default, and any of them can be taken off. Which ones are on is decided by the
 * sidebar's roster and passed in already filtered; this component is handed a list of Bots and
 * shows exactly those.
 *
 * The ROSTER costs nothing extra to serve. `/api/bots/stream` already resolves every curated
 * reference to a full catalog summary and republishes when the catalog moves, so every closed row
 * here is data the app is already holding for the sidebar: no second subscription, and no
 * per-session stream. That is what keeps a roster of thirty the same weight as a roster of three.
 *
 * An OPEN row is a different thing entirely: the whole session, the same component the app's own
 * thread view renders, with its transcript, its controls, its terminal and the composer it is typed
 * into. It is not a preview of a session, it is one -- which is why closing it unmounts rather than
 * hides it. As many can be open at once as the reader opens; see `cards/BotCanvasList` for the budget
 * that rule was measured against, and note that anything a card portals out of itself needs a node
 * of its own rather than the app's, or the open sessions land on top of each other.
 *
 * Behind its own boundary, so a canvas that throws leaves the sidebar and the tab bar standing; each
 * Bot and each session card inside has one too (`cards/BotCanvasList`, `cards/BotCanvasCard`).
 *
 * What it is handed is what the strip lays out. The commands a card issues and the facts every card
 * reads (which are open, which are off the canvas, a Bot's failure) reach the cards directly, through
 * `CanvasShell` rendered around this: see `canvasShell.tsx`.
 */
export function BotCanvas(props: ComponentProps<typeof CanvasContent>) {
  return (
    <PanelErrorBoundary surface="Bot canvas">
      <CanvasContent {...props} />
    </PanelErrorBoundary>
  );
}

function CanvasContent({
  bots,
  hues,
  ranks,
  loading,
  error,
  machines,
  keyOfBot,
  hiddenMachines,
  machineErrors,
  onMoveBot,
  detachedCount,
  onAddBot,
  canvasZoom,
}: {
  bots: BotView[];
  /**
   * Every Bot's hue, by id, computed over the WHOLE roster rather than over the cards below.
   *
   * It arrives as a prop for that reason alone: this component is given the Bots on the canvas, and
   * ranking those would recolour the strip every time a reader took one off it. See
   * `botSurface.ts`.
   */
  hues: ReadonlyMap<string, number>;
  /**
   * Every Bot's rank in the creation order, by id, over the same whole roster as the hues.
   *
   * It travels beside the hues for the same reason those arrive as a prop: the faces drawn from it
   * must rank what the reader cannot take off, not the cards on screen.
   */
  ranks: ReadonlyMap<string, number>;
  loading: boolean;
  error: string | null;
  /**
   * Every machine whose Bots this canvas reads, and EMPTY when there is only one.
   *
   * The canvas is the one surface that does not obey the tab bar's machine picker -- a Bot is a
   * directory and those are not all on one machine, so showing them side by side is the point --
   * which means it owes the reader a statement of what it IS showing. These are the machines that
   * statement names; the sidebar's canvas roster draws it, and the strip reads the answer. See
   * `BotCanvasStatus`. Used here to label a card with the machine its Bot is on.
   */
  machines: readonly { key: string; label: string }[];
  /** Which machine a Bot is on. Undefined for a Bot no roster claims, which renders unlabelled. */
  keyOfBot: (botId: string) => string | undefined;
  /**
   * Machines the reader is not showing right now, decided in the sidebar's canvas roster.
   *
   * Their cards are absent and their chip is not, which is why this arrives as a set rather than
   * as a shorter `bots`: the count beside a hidden machine's chip is what says how many cards it
   * is holding back, and the strip has to agree with it.
   */
  hiddenMachines: ReadonlySet<string>;
  /**
   * Machines that cannot be read, while others can.
   *
   * Said rather than swallowed, and said HERE rather than in `error`: a declared peer that is
   * unreachable looks exactly like a peer with no Bots on it, so an empty strip where a machine's
   * cards used to be is the one failure on this surface that reports itself as success. The canvas
   * that IS working must not be replaced to say it, which is what `error` does.
   */
  machineErrors: readonly MachineError[];
  /** Stands one Bot where another stands. By id; see `moveBot` in `useCanvasRoster`. */
  onMoveBot: (moved: string, target: string) => void;
  /**
   * How many Bots exist but are off the canvas, which is only ever asked when `bots` is empty. An
   * empty canvas that says "No bots yet" over a roster of eight is a lie, and would send the reader
   * to Add Bot rather than to the roster their Bots are already in.
   */
  detachedCount: number;
  onAddBot: () => void;
  /**
   * Draw the whole canvas at once, small enough to see the arrangement, and pinch to move around it.
   *
   * A mode rather than a replacement, and off it costs nothing: no transform and no wrapper exist
   * in the tree, so the strip keeps the pointer arithmetic and the `position: fixed` semantics it
   * has today. Driven from the sidebar's Canvas roster, which is where the canvas's other chrome
   * lives, because a strip of cards as tall as their own rosters has no row to spare. See
   * `useCanvasZoom`.
   */
  canvasZoom: { mode: boolean; room: number };
}) {
  // Nothing to lay out, so nothing below this point would be about anything: no scroller, no
  // strip, and no offset to come back to. The condition stays here rather than inside the
  // placeholder so a reader of the canvas can see when it does not draw one.
  if (loading || error !== null || bots.length === 0) {
    return <CanvasPlaceholder loading={loading} error={error} detachedCount={detachedCount} onAddBot={onAddBot} />;
  }

  return (
    // A column with one child in flow: the strip.
    <div className="relative flex h-full min-h-0 flex-col">
      <BotCanvasList
        bots={bots}
        hues={hues}
        ranks={ranks}
        machines={machines}
        keyOfBot={keyOfBot}
        hiddenMachines={hiddenMachines}
        machineErrors={machineErrors}
        onMoveBot={onMoveBot}
        canvasZoom={canvasZoom}
      />
    </div>
  );
}
