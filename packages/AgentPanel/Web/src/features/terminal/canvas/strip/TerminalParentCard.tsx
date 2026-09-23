// One directory on the terminal canvas: its head and the sessions standing in it.
//
// The Bot canvas's card with the Bot taken out. What is left is the shape both canvases share --
// a tinted card, a rail down the leading edge, a header with a count and an add button, a roster
// of rows that open downwards -- and what is gone is everything a Bot is besides a directory:
// no sizes to remember, no order to carry, no fork or rename. A parent card is exactly as big
// as the sessions standing in it, in both directions, because nothing in it states a size of
// its own.

import { EyeOff, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { BotFace, useBotFaces } from "@/features/bots/avatar/BotFace";
import { ActivityDot } from "@/features/sidebar/SessionMeta";
import { RowMenu } from "@/features/bots/menus/RowMenu";
import { botSurfaceStyle, sessionInitials } from "@/features/bots/botSurface";
import { TerminalChildCard } from "@/features/terminal/canvas/strip/TerminalChildCard";
import {
  terminalChildKey,
  terminalSessionNameError,
  type TerminalParentGroup,
} from "@/features/terminal/canvas/terminalGroups";
import { terminalChildSteps, terminalParentStyle } from "@/features/terminal/canvas/terminalSurface";

export function TerminalParentCard({
  group,
  feed,
  hue,
  rank,
  machineLabel,
  openChildren,
  onToggleChild,
  offStripChildren,
  onHideChild,
  onShowHidden,
  onKillChild,
  onHideParent,
  adding,
  addError,
  suggestedName,
  existingNames,
  onAdd,
  onDismissAddError,
}: {
  group: TerminalParentGroup;
  feed: SidecarDataSource;
  /** This directory's place on the colour wheel, over the whole roster, not the strip. */
  hue: number | undefined;
  /** This directory's rank in the path order: the face it wears, and its sessions' base. */
  rank: number | undefined;
  /** The machine this directory is on, absent when the canvas is showing only one. */
  machineLabel?: string;
  /** Which children are open, as `machine:name`, owned above this card. */
  openChildren: ReadonlySet<string>;
  onToggleChild: (key: string) => void;
  /** The children NOT on the strip, as `machine:name`. */
  offStripChildren: ReadonlySet<string>;
  onHideChild: (key: string) => void;
  /** Puts every hidden child of this parent back on the strip at once. */
  onShowHidden: () => void;
  /** Ends one child and everything running in it. A rejection renders on the child's card. */
  onKillChild: (key: string) => Promise<void>;
  /** Takes the whole parent off the strip. Its sessions keep running. */
  onHideParent: () => void;
  /** Whether a shell is being started in this directory right now. */
  adding: boolean;
  /** Why the last start failed, or null. Dismissed, not retried, from here. */
  addError: string | null;
  /** The offered name for the next shell here: `<dir>-<n>`, past every collision. */
  suggestedName: string;
  /** Every session standing on this machine: a name taken anywhere on it is a join. */
  existingNames: readonly string[];
  /** Starts a shell in this directory under the name the reader chose. Absent on the residue group: no directory, no shell. */
  onAdd?: (session: string) => void;
  onDismissAddError: () => void;
}) {
  const leaf = group.path.split("/").filter(Boolean).at(-1) ?? "Other sessions";
  // Ranked over the parent's FULL roster rather than over the rows below, for the reason
  // `botSessionShades` gives: the rows on screen are a subset twice over -- sessions taken off
  // the strip, and sessions whose listing has not arrived -- and ranking the subset would repaint
  // the rest every time one left it.
  const steps = useMemo(
    () => terminalChildSteps(group.children.map((child) => terminalChildKey(group.machineId, child.name))),
    [group.children, group.machineId],
  );
  const shown = group.children.filter(
    (child) => !offStripChildren.has(terminalChildKey(group.machineId, child.name)),
  );
  const hidden = group.children.length - shown.length;
  const live = shown.filter((child) => child.attachedClients > 0).length;
  const counted = `${shown.length} ${shown.length === 1 ? "session" : "sessions"}${
    live > 0 ? `, ${live} watched` : ""
  }${hidden > 0 ? `, ${hidden} off the strip` : ""}`;
  const holdsOpen = shown.some((child) => openChildren.has(terminalChildKey(group.machineId, child.name)));
  const faces = useBotFaces();
  // The naming step between + and the start: the input arrives prefilled with the offered
  // default, so accepting it is one press, and typing over it names the shell whatever the
  // reader wants. Kept local because the arrangement that persists is what is running, not
  // a half-typed name in a form.
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState(suggestedName);
  const [formError, setFormError] = useState<string | null>(null);
  const nameInputId = `terminal-name-${group.key}`;
  const openNaming = (): void => {
    setDraft(suggestedName);
    setFormError(null);
    setNaming(true);
  };
  // Brings this card into view when it BECOMES an open one -- the row that opened it may have
  // been nowhere near it -- and not when it mounts already open, which is the canvas coming back
  // to an arrangement rather than a reader opening something.
  const card = useRef<HTMLLIElement | null>(null);
  const wasOpen = useRef(holdsOpen);
  useEffect(() => {
    const opened = holdsOpen && !wasOpen.current;
    wasOpen.current = holdsOpen;
    if (!opened) return;
    card.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [holdsOpen]);
  const surface = hue === undefined ? "bg-card" : "terminal-surface terminal-rail";
  return (
    <li
      ref={card}
      className={`flex shrink-0 overflow-hidden rounded-xl border ${surface} ${hue === undefined ? "border-border" : ""}`}
      style={{
        ...terminalParentStyle(hue),
        // Six against a session's four: the parent is the container, and a container's edge
        // reading heavier than the edges inside it is what says which way the nesting goes.
        ...(hue === undefined ? null : { borderLeftWidth: 6 }),
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {/* `w-0 min-w-full` is what stops the header deciding how wide the card is: the card is
            sized by its contents at max-content, so the full path would set a width the sessions
            never asked for and `truncate` would never engage. */}
        <div className="flex w-0 min-w-full shrink-0 items-center gap-3 border-b border-border py-2 pr-3 pl-1 select-none">
          {/* The mark, not a dot: this directory's own face while faces are on, its initials
              on its own colour otherwise. */}
          {faces && rank !== undefined ? (
            <BotFace rank={rank} className="size-9 shrink-0" style={botSurfaceStyle(hue)} />
          ) : (
            <span
              aria-hidden
              className={`flex size-9 shrink-0 items-center justify-center rounded-full text-(length:--agent-panel-fs-sidebar-meta,13px) font-semibold ${
                hue !== undefined
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
              {group.path ? <span className="font-mono">{group.path}</span> : "sessions with no directory"}
            </span>
          </span>
          {/* A count, not a sentence: the number is the only part carrying anything, and the dot
              is there only while something is watched. */}
          <span
            className="flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium text-muted-foreground"
            title={counted}
          >
            {live > 0 ? <ActivityDot activity="live" /> : null}
            <span aria-hidden>{shown.length}</span>
            <span className="sr-only">{counted}</span>
          </span>
          {onAdd && !naming ? (
            <button
              type="button"
              onClick={openNaming}
              disabled={adding}
              aria-label={`Start a shell in ${leaf}`}
              title="Start a shell"
              className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70 disabled:cursor-wait disabled:opacity-50"
            >
              <Plus className={`size-4 ${adding ? "animate-spin" : ""}`} aria-hidden />
            </button>
          ) : null}
          <RowMenu
            label={`${leaf} directory`}
            items={[{ label: "Hide parent", icon: EyeOff, onSelect: onHideParent }]}
          />
        </div>

        {naming && onAdd ? (
          // The name is asked where the shell is started, before anything is running: a
          // collision here would join that session instead of starting one in this directory.
          <form
            aria-label={`Name the new shell in ${leaf}`}
            onSubmit={(event) => {
              event.preventDefault();
              const invalid = terminalSessionNameError(draft, existingNames);
              if (invalid) {
                setFormError(invalid);
                return;
              }
              setFormError(null);
              setNaming(false);
              onAdd(draft.trim());
            }}
            className="flex flex-col gap-2 border-b border-border px-3 py-2"
          >
            <label
              htmlFor={nameInputId}
              className="text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium text-muted-foreground"
            >
              Name the new shell
            </label>
            <input
              id={nameInputId}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              placeholder={suggestedName}
              className="min-h-9 w-full rounded-lg border border-border bg-background px-2 py-1 font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
            {formError ? (
              <p role="alert" className="text-(length:--agent-panel-fs-sidebar-chip,11px) text-destructive">
                {formError}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={adding}
                className="min-h-9 flex-1 cursor-pointer rounded-lg bg-primary px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-50"
              >
                {adding ? "Starting…" : "Start"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(suggestedName);
                  setFormError(null);
                }}
                title={`Use the default name ${suggestedName}`}
                className="min-h-9 cursor-pointer rounded-lg border border-border px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
              >
                Use default
              </button>
              <button
                type="button"
                onClick={() => setNaming(false)}
                className="min-h-9 cursor-pointer rounded-lg border border-border px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {addError ? (
          <p
            role="alert"
            className="flex items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive"
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

        {shown.length === 0 ? (
          <p className="px-3 py-3 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            {hidden > 0
              ? `${hidden === 1 ? "Its session is" : "All of its sessions are"} off the strip`
              : group.path
                ? "Empty — start a shell with +"
                : "Nothing placeless is running"}
          </p>
        ) : (
          // Sessions stand SIDE BY SIDE, the same shape the canvas has one level up: opening one
          // grows downwards in its own place while the rest keep theirs.
          <ul role="list" aria-label={`${leaf} sessions`} className="flex items-start gap-4 p-2.5 pl-2">
            {shown.map((child) => {
              const key = terminalChildKey(group.machineId, child.name);
              return (
                <TerminalChildCard
                  key={key}
                  session={child}
                  feed={feed}
                  machineId={group.machineId}
                  hue={hue}
                  step={steps.get(key)}
                  rank={rank}
                  solo={group.children.length === 1}
                  open={openChildren.has(key)}
                  onToggle={() => onToggleChild(key)}
                  onHide={() => onHideChild(key)}
                  onKill={() => onKillChild(key)}
                  storageKey={key}
                  openKeys={openChildren}
                  onToggleKey={onToggleChild}
                />
              );
            })}
          </ul>
        )}
        {/* The way back for what was taken off: named in the count's long form is not enough,
            because the count is a title attribute and the reader who has forgotten is not
            hovering. A parent with every session hidden is still a parent on the strip -- its
            header is where shells are started, and dropping the card would take that away. */}
        {hidden > 0 ? (
          <button
            type="button"
            onClick={onShowHidden}
            className="cursor-pointer border-t border-border px-3 py-2 text-left text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
          >
            Show {hidden} hidden {hidden === 1 ? "session" : "sessions"}
          </button>
        ) : null}
      </div>
    </li>
  );
}
