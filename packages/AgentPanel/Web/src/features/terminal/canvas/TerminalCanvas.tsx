// The terminal canvas: every machine's directories standing side by side, in one scroll.
//
// The Bot canvas's strip with the Bot taken out. One strip, nothing wrapping out of it; parents
// path-sorted, children name-sorted, both decided by the grouping rather than arranged. What the
// reader DOES arrange -- hidden parents, off-strip children, open children, hidden machines --
// arrives as sets owned above this component and persisted beside it, the same split the Bot
// canvas keeps. Closing a child unmounts its tile rather than hiding it, which is what keeps a
// closed card free: the terminal's subscriptions belong to hooks inside the tile, so they end
// with it.

import { LoaderCircle, SquareTerminal } from "lucide-react";
import { useRef } from "react";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { useCanvasZoom } from "@/features/bots/useCanvasZoom";
import { TerminalParentCard } from "@/features/terminal/canvas/TerminalParentCard";
import {
  parseTerminalChildKey,
  suggestTerminalSessionName,
  type TerminalGrouping,
  type TerminalParentGroup,
} from "@/features/terminal/canvas/terminalGroups";
import { TERMINAL_ZOOM_STORAGE } from "@/features/terminal/canvas/terminalCanvasPreferences";
import { useTerminalCanvasScroll } from "@/features/terminal/canvas/useTerminalCanvasScroll";

export function TerminalCanvas({
  grouping,
  hues,
  ranks,
  loading,
  error,
  machineErrors,
  machines,
  hiddenMachines,
  onToggleMachine,
  feedFor,
  hiddenParents,
  onHideParent,
  onShowParent,
  offStripChildren,
  onHideChild,
  onShowHiddenChildren,
  openChildren,
  onToggleChild,
  onKillChild,
  addingKeys,
  addErrors,
  onAddTerminal,
  onDismissAddError,
  orphanedError,
  onRefresh,
  canvasZoom,
}: {
  /** The whole roster, every machine, before hiding: ranks and counts read this, not the strip. */
  grouping: TerminalGrouping;
  /** Every parent's hue, by `machine:path`, computed over the whole roster above. */
  hues: ReadonlyMap<string, number>;
  /** Every parent's rank in the path order, by key: the face each parent wears. */
  ranks: ReadonlyMap<string, number>;
  loading: boolean;
  error: string | null;
  /** Machines that cannot be read, while others can. Said, not swallowed. */
  machineErrors: readonly { label: string; reason: string }[];
  /** Every machine the canvas reads, home first. Empty when there is only one. */
  machines: readonly { key: string; label: string }[];
  /** Machines the reader is not showing right now. Their cards are absent, their chip is not. */
  hiddenMachines: ReadonlySet<string>;
  onToggleMachine: (key: string) => void;
  /** The sidecar that owns this parent's directory. */
  feedFor: (machineId: string | undefined) => SidecarDataSource;
  /** Parents the reader has taken off the strip, by `machine:path`. */
  hiddenParents: ReadonlySet<string>;
  onHideParent: (key: string) => void;
  onShowParent: (key: string) => void;
  /** Children NOT on the strip, as `machine:name`. */
  offStripChildren: ReadonlySet<string>;
  onHideChild: (key: string) => void;
  /** Puts every hidden child of one parent back on the strip at once. */
  onShowHiddenChildren: (parentKey: string) => void;
  /** Which children are open, as `machine:name`, owned above this component. */
  openChildren: ReadonlySet<string>;
  onToggleChild: (key: string) => void;
  /**
   * Ends one child and everything running in it, then takes it off the strip.
   *
   * Takes the key rather than the session because the answer is machine-scoped: the shell
   * parses it and kills through the machine's own sidecar.
   */
  onKillChild: (key: string) => Promise<void>;
  /** Parents with a start in flight, by `machine:path`. */
  addingKeys: ReadonlySet<string>;
  /** Why a start failed, by `machine:path`. */
  addErrors: ReadonlyMap<string, string>;
  /** Starts a shell in this parent's directory under the name the reader chose. */
  onAddTerminal: (parent: TerminalParentGroup, session: string) => void;
  onDismissAddError: (parentKey: string) => void;
  /** A failure no card can carry, because it is about no child or one not on the canvas. */
  orphanedError: string | null;
  onRefresh: () => void;
  /**
   * Draw the whole strip at once, small enough to see the arrangement, and pinch to move
   * around it. A mode rather than a replacement, driven from the roster beside the strip --
   * the same split the Bot canvas keeps, because a strip of cards as tall as their own
   * rosters has no row to spare. See `useCanvasZoom`.
   */
  canvasZoom: { mode: boolean; room: number };
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const strip = useRef<HTMLUListElement | null>(null);
  const all = [...grouping.parents, ...grouping.residue];
  const standing = all.filter((parent) => !hiddenMachines.has(parent.machineId ?? ""));
  const drawn = standing.filter((parent) => !hiddenParents.has(parent.key));
  const mixed = machines.length > 1;
  const machineLabelOf = (machineId: string | undefined): string | undefined => {
    if (!mixed) return undefined;
    return machines.find((machine) => machine.key === (machineId ?? ""))?.label;
  };
  // The whole strip drawn small, with pinch and press-to-a-card gestures. Off, nothing here
  // renders and no transform exists in the tree, so the default strip keeps its own pointer
  // arithmetic byte for byte. Its own storage keys, never the Bot canvas's.
  //
  // `on` includes the strip being in the page, not just the mode: while the placeholder below
  // shows, neither node exists, and an effect keyed on the refs alone never re-runs when they
  // attach. Passing the bare mode left a mode restored as ON unmeasured at 1:1 forever, its
  // stored scale intact but never drawn; the flip from false to true IS what measures the strip
  // and attaches the gestures.
  const zoom = useCanvasZoom({
    scroller,
    strip,
    on: canvasZoom.mode && !loading && error === null && all.length > 0,
    room: canvasZoom.room,
    storage: TERMINAL_ZOOM_STORAGE,
  });
  // The stored offset is in content space, so it cannot be put back until the scale is known.
  const rememberScroll = useTerminalCanvasScroll(scroller, all.length, {
    scale: zoom.scale,
    ready: !zoom.on || zoom.measured,
    pad: zoom.pad,
  });
  const hiddenKeys = [...hiddenParents].sort();

  // Held in a const rather than written inline because the sizer below wraps it only while the
  // zoom mode is drawing small, and JSX has no way to conditionally wrap an element in place.
  const stripEl = (
    <ul
      ref={strip}
      role="list"
      aria-label="Terminal canvas"
      style={zoom.stripStyle}
      className="flex w-max items-start gap-3 p-3"
    >
      {drawn.map((parent) => {
        // Machine-wide, not just this card's: names are per-server, so the default must step
        // over a name standing anywhere on this machine, not just in this directory.
        const standing = all
          .filter((each) => (each.machineId ?? "") === (parent.machineId ?? ""))
          .flatMap((each) => each.children.map((child) => child.name));
        return (
          <TerminalParentCard
            key={parent.key}
            group={parent}
            feed={feedFor(parent.machineId)}
            hue={hues.get(parent.key)}
            rank={ranks.get(parent.key)}
            {...(machineLabelOf(parent.machineId) ? { machineLabel: machineLabelOf(parent.machineId)! } : {})}
            openChildren={openChildren}
            onToggleChild={onToggleChild}
            offStripChildren={offStripChildren}
            onHideChild={onHideChild}
            onShowHidden={() => onShowHiddenChildren(parent.key)}
            onKillChild={onKillChild}
            onHideParent={() => onHideParent(parent.key)}
            adding={addingKeys.has(parent.key)}
            addError={addErrors.get(parent.key) ?? null}
            suggestedName={suggestTerminalSessionName(parent.path, standing)}
            existingNames={standing}
            {...(parent.path ? { onAdd: (session: string) => onAddTerminal(parent, session) } : {})}
            onDismissAddError={() => onDismissAddError(parent.key)}
          />
        );
      })}
    </ul>
  );

  if (loading || error !== null || all.length === 0) {
    return (
      <div
        role={error ? "alert" : "status"}
        className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground"
      >
        {loading ? (
          <>
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Reading tmux sessions…
          </>
        ) : error ? (
          <span className="text-destructive">Terminals unavailable: {error}</span>
        ) : (
          <>
            <SquareTerminal className="size-5" aria-hidden />
            <span>No sessions standing. Directories appear here once a machine reports them.</span>
            <button
              type="button"
              onClick={onRefresh}
              className="mt-1 min-h-9 cursor-pointer rounded-lg border border-border px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary active:bg-primary/15"
            >
              Refresh
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The machine row and the listing's refresh live here rather than in the shell, because
          the canvas reads every machine at once while the picker scopes everything else to one:
          a reader who started a session elsewhere needs the way back on the surface showing it.
          One machine still gets the row, holding only the refresh -- hiding it there would leave
          a single-machine canvas with no way to re-read at all. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2" role="group" aria-label="Machines">
        {mixed ? machines.map((machine) => {
            const hidden = hiddenMachines.has(machine.key);
            const count = all.filter((parent) => (parent.machineId ?? "") === machine.key).length;
            return (
              <button
                key={machine.key}
                type="button"
                onClick={() => onToggleMachine(machine.key)}
                aria-pressed={!hidden}
                title={hidden ? `Show ${machine.label} (${count} hidden)` : `Hide ${machine.label}`}
                className={`min-h-9 cursor-pointer rounded-md border px-2 py-1 text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
                  hidden
                    ? "border-border text-muted-foreground opacity-60 hover:bg-muted"
                    : "border-border bg-muted text-foreground hover:bg-muted/60"
                }`}
              >
                {machine.label} · {hidden ? `${count} hidden` : count}
              </button>
            );
          }) : null}
          <button
            type="button"
            onClick={onRefresh}
            className="min-h-9 cursor-pointer rounded-md border border-border px-2 py-1 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
          >
            Refresh
          </button>
        </div>
      <div
        ref={scroller}
        onScroll={rememberScroll}
        style={zoom.scrollerStyle}
        className="mx-4 h-full min-h-0 flex-1 overflow-auto overscroll-contain"
      >
        {machineErrors.map(({ label, reason }) => (
          <div
            key={label}
            role="status"
            className="mx-3 mt-3 rounded-lg border border-border bg-muted/60 px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground"
          >
            {label} is not answering, so its sessions are not on the canvas: {reason}
          </div>
        ))}
        {/* A strip emptied by the machine chips rather than by having no sessions. Without this
            the scroller is simply blank, and the two look identical to a reader who has forgotten
            pressing one. */}
        {drawn.length === 0 && standing.length > 0 ? (
          <div
            role="status"
            className="mx-3 mt-3 rounded-lg border border-border bg-muted/60 px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground"
          >
            {standing.length} {standing.length === 1 ? "parent is" : "parents are"} on machines
            you have hidden. The machines are in the row above the strip.
          </div>
        ) : null}
        {orphanedError ? (
          <div
            role="alert"
            className="mx-3 mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive"
          >
            {orphanedError}
          </div>
        ) : null}
        {/* The SIZER. A transform does not change `scrollWidth`, so without a box sized to
            what is actually drawn the scroller keeps a range several times wider than its
            contents. Always rendered, and `display: contents` while the mode is off -- so it
            generates no box and the strip is laid out exactly as though it were still the
            scroller's own child. Rendering it conditionally would remount every open tile
            inside the strip, tearing down every live terminal on each toggle. */}
        <div style={zoom.sizerStyle}>{stripEl}</div>
        {/* The way back for hidden parents. The Bot canvas leans on the sidebar roster for this;
            this canvas has no roster, so the strip ends with its own. Stale keys -- a directory
            no machine reports any more -- still list, because forgetting a hidden parent would put
            it back on a strip the reader had tidied. */}
        {hiddenKeys.length > 0 ? (
          <section aria-label="Hidden parents" className="mx-3 mb-3 rounded-xl border border-border px-3 py-2">
            <h2 className="text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium text-muted-foreground">
              {hiddenKeys.length} hidden {hiddenKeys.length === 1 ? "parent" : "parents"}
            </h2>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {hiddenKeys.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => onShowParent(key)}
                    className="min-h-9 cursor-pointer rounded-md border border-border px-2 py-1 font-mono text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    {hiddenParentLabel(key, machines)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What a hidden-parents button names, from a key no grouping may still hold.
 *
 * Split on the FIRST colon, the way `parseTerminalChildKey` does: machine keys never hold one,
 * so the rest is the path -- or empty, for a residue group, which names itself honestly.
 */
function hiddenParentLabel(
  key: string,
  machines: readonly { key: string; label: string }[],
): string {
  const at = key.indexOf(":");
  const machine = at < 0 ? "" : key.slice(0, at);
  const path = at < 0 ? key : key.slice(at + 1);
  const leaf = path.split("/").filter(Boolean).at(-1) ?? "Other sessions";
  const label = machines.find((each) => each.key === machine)?.label ?? (machine || "this machine");
  return `${leaf} · ${label}`;
}
