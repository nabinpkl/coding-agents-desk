// The terminal roster: every directory and the sessions standing in it, listed vertically.
//
// The Bot sidebar's panel with the Bot taken out. Same contract both ways: the rows are the whole
// roster, dimmed rather than dropped while off the strip, and a row for something off it is the
// way back -- clicking it clears the hiding and opens the session, the same thing the canvas
// card's scroll effect then brings into view. The hues are the canvas's own, passed in rather
// than derived, because the shell ranks the whole roster once and both surfaces read that answer.

import { Eye, EyeOff, LoaderCircle, Plus, Skull, SquareTerminal, X } from "lucide-react";
import { useState } from "react";
import type { TmuxSessionSummary } from "@agentdesk/agent-feed-wire";
import { RowMenu, type RowMenuItem } from "@/features/bots/menus/RowMenu";
import { sessionInitials } from "@/features/bots/botSurface";
import {
  terminalChildKey,
  type TerminalGrouping,
  type TerminalParentGroup,
} from "@/features/terminal/canvas/terminalGroups";
import {
  terminalChildSteps,
  terminalChildStyle,
  terminalParentStyle,
} from "@/features/terminal/canvas/terminalSurface";

export function TerminalSidebarPanel({
  grouping,
  hues,
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
  /** Starts a shell in a parent's directory. */
  onAddTerminal: (parent: TerminalParentGroup) => void;
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
  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-foreground">
      <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <h2 className="min-w-0 flex-1 truncate px-1.5 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold">
          Terminals{sessionCount > 0 ? ` · ${sessionCount}` : ""}
        </h2>
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
      {/* The machine chips live here as well as above the strip, because a reader with this list
          open is looking here and not there: hiding a machine from one surface while reading the
          other must not need a trip across the page. Same sets both places, so they cannot
          disagree. */}
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
              {all.map((parent) => (
                <TerminalSidebarParent
                  key={parent.key}
                  parent={parent}
                  hue={hues.get(parent.key)}
                  machineLabel={mixed
                    ? machines.find((machine) => machine.key === (parent.machineId ?? ""))?.label
                    : undefined}
                  // Two axes with two controls, kept apart the way the Bot roster keeps them:
                  // this row owns the parent's own hiding, and the machine chip above owns the
                  // other. A machine-hidden parent stays listed and dims the same way, but its
                  // eye is disabled rather than relabelled -- pressing it would move this
                  // parent's own membership and still leave the strip exactly as it was.
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
                  {...(parent.path ? { onAdd: () => onAddTerminal(parent) } : {})}
                  onDismissAddError={() => onDismissAddError(parent.key)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function TerminalSidebarParent({
  parent,
  hue,
  machineLabel,
  machineHidden,
  offStrip,
  offStripChildren,
  openChildren,
  onToggleParent,
  onSelectChild,
  onHideChild,
  onKillChild,
  adding,
  addError,
  onAdd,
  onDismissAddError,
}: {
  parent: TerminalParentGroup;
  hue: number | undefined;
  machineLabel: string | undefined;
  /** This parent's machine is hidden: listed and dimmed, eye disabled -- see above. */
  machineHidden: boolean;
  /** This parent is off the strip: its rows dim but stay listed, the way back being here. */
  offStrip: boolean;
  offStripChildren: ReadonlySet<string>;
  openChildren: ReadonlySet<string>;
  onToggleParent: () => void;
  onSelectChild: (childKey: string) => void;
  onHideChild: (key: string) => void;
  onKillChild: (key: string) => Promise<void>;
  adding: boolean;
  addError: string | null;
  onAdd?: () => void;
  onDismissAddError: () => void;
}) {
  const leaf = parent.path.split("/").filter(Boolean).at(-1) ?? "Other sessions";
  // Ranked over the parent's FULL roster, the way the card ranks its own: the rows on screen
  // are a subset, and ranking the subset would repaint the rest every time one left it.
  const steps = terminalChildSteps(
    parent.children.map((child) => terminalChildKey(parent.machineId, child.name)),
  );
  const live = parent.children.filter((child) => child.attachedClients > 0).length;
  // Off the strip by either route reads as one fact here: no card either way, and the row
  // states the one a reader can act on from here.
  const off = offStrip || machineHidden;
  return (
    <li className="border-b border-border/80">
      <div
        // The same surface and rail its card wears, so one directory is one colour in both
        // places -- and only while it has a card. Off the strip the header goes neutral and
        // dim, and the EyeOff says so in words the dimming cannot.
        className={`flex min-h-16 items-center gap-3 border-l-2 py-2 pr-2 pl-1 ${
          hue !== undefined && !off ? "terminal-surface terminal-rail" : "border-transparent"
        } ${off ? "opacity-55" : ""}`}
        style={hue === undefined || off ? undefined : terminalParentStyle(hue)}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-(length:--agent-panel-fs-sidebar-body,15px) font-semibold text-foreground">
            {leaf}
          </span>
          <span className="block truncate text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
            {machineLabel ? <span className="font-medium">{machineLabel}</span> : null}
            {machineLabel ? " · " : ""}
            {parent.path
              ? <span className="font-mono">{parent.path}</span>
              : "sessions with no directory"}
            {live > 0 ? ` · ${live} watched` : ""}
          </span>
        </span>
        {onAdd ? (
          <button
            type="button"
            onClick={onAdd}
            disabled={adding}
            aria-label={`Start a shell in ${leaf}`}
            title="Start a shell"
            className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-background/70 disabled:cursor-wait disabled:opacity-50"
          >
            <Plus className={`size-4 ${adding ? "animate-spin" : ""}`} aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onToggleParent}
          disabled={machineHidden}
          aria-pressed={!off}
          aria-label={machineHidden
            ? `${leaf} is on ${machineLabel ?? "a machine"}, which is hidden from the strip`
            : offStrip ? `Put ${leaf} on the strip` : `Take ${leaf} off the strip`}
          title={machineHidden
            ? `${machineLabel ?? "This machine"} is hidden from the strip. Show it above to bring ${leaf} back.`
            : offStrip ? "Off the strip" : "On the strip"}
          className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-background/70 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
        >
          {off ? <Eye className="size-4" aria-hidden /> : <EyeOff className="size-4" aria-hidden />}
        </button>
      </div>
      {addError ? (
        <p
          role="alert"
          className="flex items-center justify-between gap-2 border-t border-destructive/40 bg-destructive/10 px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive"
        >
          <span className="min-w-0 flex-1 truncate">{addError}</span>
          <button
            type="button"
            onClick={onDismissAddError}
            className="shrink-0 cursor-pointer underline outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Dismiss
          </button>
        </p>
      ) : null}
      {parent.children.length > 0 ? (
        <ul role="list" aria-label={`${leaf} sessions`} className="pb-1">
          {parent.children.map((child) => (
            <TerminalSidebarChild
              key={terminalChildKey(parent.machineId, child.name)}
              session={child}
              hue={hue}
              step={steps.get(terminalChildKey(parent.machineId, child.name))}
              // One fact, two routes: the reader took the child off, or the whole parent --
              // or the parent's machine. Either way there is no card, so the row dims and
              // the click is the way back.
              noCard={off || offStripChildren.has(terminalChildKey(parent.machineId, child.name))}
              offStripChild={offStripChildren.has(terminalChildKey(parent.machineId, child.name))}
              open={openChildren.has(terminalChildKey(parent.machineId, child.name))}
              onSelect={() => onSelectChild(terminalChildKey(parent.machineId, child.name))}
              onHide={() => onHideChild(terminalChildKey(parent.machineId, child.name))}
              onShow={() => onSelectChild(terminalChildKey(parent.machineId, child.name))}
              onKill={() => onKillChild(terminalChildKey(parent.machineId, child.name))}
            />
          ))}
        </ul>
      ) : (
        <p className="pb-2 pr-3 pl-4 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          {parent.path ? "Empty — start a shell with +" : "Nothing placeless is running"}
        </p>
      )}
    </li>
  );
}

function TerminalSidebarChild({
  session,
  hue,
  step,
  noCard,
  offStripChild,
  open,
  onSelect,
  onHide,
  onShow,
  onKill,
}: {
  session: TmuxSessionSummary;
  hue: number | undefined;
  step: number | undefined;
  /** No card for this session right now, by either route. */
  noCard: boolean;
  /** This child itself is off the strip (as opposed to its parent being off). */
  offStripChild: boolean;
  open: boolean;
  onSelect: () => void;
  onHide: () => void;
  onShow: () => void;
  onKill: () => Promise<void>;
}) {
  const shaded = terminalChildStyle(hue, step);
  const [confirming, setConfirming] = useState(false);
  const [killing, setKilling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kill = (): void => {
    setKilling(true);
    setError(null);
    void onKill().then(
      () => {
        setKilling(false);
        setConfirming(false);
      },
      (cause: unknown) => {
        setKilling(false);
        setConfirming(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };
  // The menu names the way back when there is one: a row already off the strip offers to put
  // itself back, the same thing clicking it does.
  const items: RowMenuItem[] = [
    { label: open ? "Close terminal" : "Open terminal", icon: open ? X : Eye, onSelect },
    offStripChild
      ? { label: "Put back on strip", icon: Eye, onSelect: onShow }
      : { label: "Take off strip", icon: EyeOff, onSelect: onHide },
    { label: "Kill session", icon: Skull, onSelect: () => setConfirming(true) },
  ];
  const watched = session.attachedClients > 0
    ? `${session.attachedClients} watching`
    : "unattached";
  return (
    <li
      // The same fill and rail its card wears, and only while it has one: the colour is what a
      // card looks like, so a row with no card gives it up and goes neutral and dim.
      className={`flex items-center border-l-2 pr-1.5 ${
        shaded && !noCard ? "terminal-session-fill terminal-session-edge" : "border-transparent"
      } ${noCard ? "opacity-55" : ""}`}
      style={shaded}
    >
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onSelect}
          aria-current={open ? "page" : undefined}
          className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pr-2 pl-2 text-left text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80"
        >
          <span
            aria-hidden
            className={`flex size-8 shrink-0 items-center justify-center rounded-full text-(length:--agent-panel-fs-sidebar-chip,11px) font-semibold ${
              shaded && !noCard
                ? "terminal-session-accent text-foreground"
                : "border border-border bg-muted text-muted-foreground"
            } ${session.attachedClients > 0 ? "ring-2 ring-green-500" : ""}`}
          >
            {sessionInitials(session.name)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium">
              {session.name}
            </span>
            <span className="block truncate text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
              {watched} · {session.windows} {session.windows === 1 ? "window" : "windows"}
            </span>
          </span>
          {noCard ? (
            <span
              role="img"
              aria-label="Off the strip"
              title="Off the strip"
              className="flex shrink-0 items-center text-muted-foreground"
            >
              <EyeOff className="size-3.5" aria-hidden />
            </span>
          ) : null}
        </button>
        {confirming ? (
          <div
            role="alertdialog"
            aria-label={`Kill ${session.name}?`}
            className="mx-2 mb-1 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2"
          >
            <p className="text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
              Kill {session.name}? Its processes die with it.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={killing}
                className="min-h-9 flex-1 cursor-pointer rounded-lg border border-border px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
              >
                Keep it
              </button>
              <button
                type="button"
                onClick={kill}
                disabled={killing}
                className="min-h-9 flex-1 cursor-pointer rounded-lg bg-destructive px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-white outline-none transition-colors hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
              >
                {killing ? "Killing…" : "Kill it"}
              </button>
            </div>
          </div>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="mx-2 mb-1 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>
      <RowMenu label={`${session.name} terminal`} items={items} />
    </li>
  );
}
