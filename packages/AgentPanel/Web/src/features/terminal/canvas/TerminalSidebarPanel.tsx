// The terminal roster: every directory and the sessions standing in it, listed vertically.
//
// The Bot sidebar's panel with the Bot taken out. The rows are the whole roster, dimmed rather
// than dropped while off the strip, and a row for something off it is the way back. Hues arrive
// as props because the shell ranks the whole roster once and both surfaces read that answer.

import { LoaderCircle, ScanFace, SquareTerminal, X } from "lucide-react";
import { setBotFaces, useBotFaces } from "@/features/bots/avatar/BotFace";
import {
  suggestTerminalSessionName,
  type TerminalGrouping,
  type TerminalParentGroup,
} from "@/features/terminal/canvas/terminalGroups";
import { TerminalSidebarParent } from "@/features/terminal/canvas/TerminalSidebarRows";

export function TerminalSidebarPanel({
  grouping,
  hues,
  ranks,
  loading,
  error,
  machineErrors,
  machines,
  hiddenMachines,
  onToggleMachine,
  hiddenParents,
  onHideParent,
  onShowParent,
  offStripChildren,
  openChildren,
  onSelectChild,
  onHideChild,
  onKillChild,
  onAddTerminal,
  addingKeys,
  addErrors,
  onDismissAddError,
  onRefresh,
  onClose,
}: {
  /** The whole roster, every machine, before hiding: the rows list this, not the strip. */
  grouping: TerminalGrouping;
  /** Every parent's hue, by `machine:path`, ranked over the whole roster by the shell. */
  hues: ReadonlyMap<string, number>;
  /** Every parent's rank in the path order, by key: the face each parent wears. */
  ranks: ReadonlyMap<string, number>;
  loading: boolean;
  error: string | null;
  /** Machines that cannot be read, while others can. Said, not swallowed. */
  machineErrors: readonly { label: string; reason: string }[];
  /** Every machine the canvas reads, home first. Empty when there is only one. */
  machines: readonly { key: string; label: string }[];
  /** Machines the reader is not showing right now. */
  hiddenMachines: ReadonlySet<string>;
  onToggleMachine: (key: string) => void;
  /** Parents the reader has taken off the strip, by `machine:path`. */
  hiddenParents: ReadonlySet<string>;
  onHideParent: (key: string) => void;
  onShowParent: (key: string) => void;
  /** Children NOT on the strip, as `machine:name`. */
  offStripChildren: ReadonlySet<string>;
  /** Which children are open, as `machine:name`. */
  openChildren: ReadonlySet<string>;
  /** Opens a child on the canvas, putting back whatever hiding is in the way. */
  onSelectChild: (parentKey: string, childKey: string) => void;
  /** Takes a child off the strip. The session keeps running; this list still names it. */
  onHideChild: (key: string) => void;
  /** Ends a child and everything running in it. A rejection renders on the row that asked. */
  onKillChild: (key: string) => Promise<void>;
  /** Starts a shell in a parent's directory under the name the reader chose. */
  onAddTerminal: (parent: TerminalParentGroup, session: string) => void;
  /** Parents with a start in flight, by `machine:path`. */
  addingKeys: ReadonlySet<string>;
  /** Why a start failed, by `machine:path`. */
  addErrors: ReadonlyMap<string, string>;
  onDismissAddError: (parentKey: string) => void;
  onRefresh: () => void;
  /** Hides this list, giving the strip the width back. */
  onClose: () => void;
}) {
  const all = [...grouping.parents, ...grouping.residue];
  const mixed = machines.length > 1;
  const sessionCount = all.reduce((total, parent) => total + parent.children.length, 0);
  const faces = useBotFaces();
  return (
    // `flex-1` rather than `h-full`: the status block stands above this panel in the same
    // aside, and a full height beside a sibling is an overflow.
    <div className="flex min-h-0 flex-1 flex-col bg-card text-foreground">
      <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <h2 className="min-w-0 flex-1 truncate px-1.5 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold">
          Terminals{sessionCount > 0 ? ` · ${sessionCount}` : ""}
        </h2>
        {/* The one control for the faces switch, so the roster and the strip move together. */}
        <button
          type="button"
          onClick={() => setBotFaces(!faces)}
          aria-pressed={faces}
          aria-label={faces ? "Show session initials instead of faces" : "Show session faces instead of initials"}
          title={faces ? "Showing faces" : "Showing initials"}
          className="mr-1 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary aria-pressed:text-primary text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted/80"
        >
          <ScanFace className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close terminal list"
          title="Close terminal list"
          className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70"
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>
      {/* The machine chips live here as well as above the strip: a reader with this list open is
          looking here and not there. Same sets both places, so they cannot disagree. */}
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
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loading ? (
          <div role="status" className="flex min-h-28 items-center justify-center gap-2 p-4 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Reading tmux sessions…
          </div>
        ) : error ? (
          <div role="alert" className="p-4 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
            Terminals unavailable: {error}
          </div>
        ) : all.length === 0 ? (
          <div role="status" className="flex min-h-28 flex-col items-center justify-center gap-2 p-4 text-center text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            <SquareTerminal className="size-5" aria-hidden />
            No sessions standing
          </div>
        ) : (
          <>
            {machineErrors.map(({ label, reason }) => (
              <p
                key={label}
                role="status"
                className="mx-3 mt-3 rounded-lg border border-border bg-muted/60 px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground"
              >
                {label} is not answering, so its sessions are not listed: {reason}
              </p>
            ))}
            <ul role="list" aria-label="Terminal parents">
              {all.map((parent) => {
                // Machine-wide, the way the strip's cards read it: a default that collides
                // anywhere on this server joins instead of starting.
                const standing = all
                  .filter((each) => (each.machineId ?? "") === (parent.machineId ?? ""))
                  .flatMap((each) => each.children.map((child) => child.name));
                return (
                <TerminalSidebarParent
                  key={parent.key}
                  parent={parent}
                  hue={hues.get(parent.key)}
                  rank={ranks.get(parent.key)}
                  machineLabel={mixed
                    ? machines.find((machine) => machine.key === (parent.machineId ?? ""))?.label
                    : undefined}
                  // Two axes with two controls: this row owns the parent's own hiding, the chip
                  // above owns the machine's. A machine-hidden parent stays listed and dims the
                  // same way, but its eye is disabled -- pressing it would move this parent's
                  // own membership and still leave the strip exactly as it was.
                  machineHidden={hiddenMachines.has(parent.machineId ?? "")}
                  offStrip={hiddenParents.has(parent.key)}
                  offStripChildren={offStripChildren}
                  openChildren={openChildren}
                  onToggleParent={() => hiddenParents.has(parent.key)
                    ? onShowParent(parent.key)
                    : onHideParent(parent.key)}
                  onSelectChild={(childKey) => onSelectChild(parent.key, childKey)}
                  onHideChild={onHideChild}
                  onKillChild={onKillChild}
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
          </>
        )}
      </div>
    </div>
  );
}
