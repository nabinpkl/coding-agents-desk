// One directory and its sessions as roster rows: the terminal sidebar's vertical half.
//
// Split from `TerminalSidebarPanel` when that file reached the 500-line cap: the panel owns the
// header, the machine chips and the scroller, and everything from a parent header down lives
// here. One directory per file is what the cap asks for once a file stops being one idea.

import { Eye, EyeOff, Plus, Skull, X } from "lucide-react";
import { useState } from "react";
import type { TmuxSessionSummary } from "@agentdesk/agent-feed-wire";
import { BotFace, useBotFaces } from "@/features/bots/avatar/BotFace";
import { RowMenu, type RowMenuItem } from "@/features/bots/menus/RowMenu";
import {
  botSessionFaceRank,
  botSessionStyle,
  botSurfaceStyle,
  sessionInitials,
} from "@/features/bots/botSurface";
import {
  terminalChildKey,
  type TerminalParentGroup,
} from "@/features/terminal/canvas/terminalGroups";
import {
  terminalChildSteps,
  terminalChildStyle,
  terminalParentStyle,
} from "@/features/terminal/canvas/terminalSurface";

export function TerminalSidebarParent({
  parent,
  hue,
  rank,
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
  /** This parent's rank in the path order: the face it wears, and its sessions' base. */
  rank: number | undefined;
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
  const faces = useBotFaces();
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
        {/* The mark, not a dot: this directory's own face while faces are on, its initials on
            its own colour otherwise -- the same answer the Bot roster gives, one level up. */}
        {faces && rank !== undefined ? (
          <BotFace rank={rank} className="size-10 shrink-0" style={botSurfaceStyle(hue)} />
        ) : (
          <span
            aria-hidden
            className={`flex size-10 shrink-0 items-center justify-center rounded-full text-(length:--agent-panel-fs-sidebar-body,15px) font-semibold ${
              hue !== undefined && !off
                ? "terminal-surface text-foreground"
                : "border border-border bg-muted text-muted-foreground"
            }`}
          >
            {sessionInitials(leaf)}
          </span>
        )}
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
        // Indented under the header, so the rows read as this directory's sessions rather than
        // as siblings of it. The header's mark and the rows' marks state the same nesting in
        // colour; this states it in space, which is what the eye finds first.
        <ul role="list" aria-label={`${leaf} sessions`} className="pb-1 pl-4">
          {parent.children.map((child) => {
            const childKey = terminalChildKey(parent.machineId, child.name);
            const step = steps.get(childKey);
            return (
              <TerminalSidebarChild
                key={childKey}
                session={child}
                hue={hue}
                step={step}
                // Its own face rather than its parent's, so siblings never share one.
                faceRank={rank !== undefined && step !== undefined
                  ? botSessionFaceRank(rank, step)
                  : undefined}
                // One fact, two routes: the reader took the child off, or the whole parent --
                // or the parent's machine. Either way there is no card, so the row dims and
                // the click is the way back.
                noCard={off || offStripChildren.has(childKey)}
                offStripChild={offStripChildren.has(childKey)}
                open={openChildren.has(childKey)}
                onSelect={() => onSelectChild(childKey)}
                onHide={() => onHideChild(childKey)}
                onShow={() => onSelectChild(childKey)}
                onKill={() => onKillChild(childKey)}
              />
            );
          })}
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
  faceRank,
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
  /** Which face this session wears, from its parent's rank and its own step. */
  faceRank: number | undefined;
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
  const faces = useBotFaces();
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
  // A face of its own while faces are on, one size under the parent's: the same containment
  // the card already draws, said where the eye starts. Unshaded keeps its disc whatever the
  // switch says -- a face with no hue in scope has no colour to take.
  const faced = faces && faceRank !== undefined && shaded !== undefined;
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
          {faced ? (
            // The live ring stays, because the face says which session this is and only the
            // ring says whether it is live.
            <BotFace
              rank={faceRank as number}
              className={`size-8 shrink-0 ${session.attachedClients > 0 ? "rounded-full ring-2 ring-green-500" : ""}`}
              style={botSessionStyle(hue, step)}
            />
          ) : (
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
          )}
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
