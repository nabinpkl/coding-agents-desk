// One tmux session on the terminal canvas: a row until it is opened, a tile after.
//
// The Bot canvas's session card one level down, minus everything a provider session has: no
// transcript, no composer, no fork, no rename. What is open here is a viewer on a pane somebody
// else is running -- `TerminalTile` -- so opening mounts it and closing unmounts it, and the
// width is the tile's own 80 columns rather than anything remembered. Closing never ends the
// session; ending one is the menu's confirmed kill, which is the opposite actor and stays the
// opposite path.

import { ChevronDown, EyeOff, Skull, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TmuxSessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { RowMenu, type RowMenuItem } from "@/features/bots/menus/RowMenu";
import { sessionInitials } from "@/features/bots/botSurface";
import { CLOSED_SESSION_WIDTH } from "@/features/bots/cards/botCanvasCards";
import { TerminalTile } from "@/features/terminal/TerminalTile";
import { terminalChildStyle } from "@/features/terminal/canvas/terminalSurface";

export function TerminalChildCard({
  session,
  feed,
  hue,
  step,
  solo,
  open,
  onToggle,
  onHide,
  onKill,
}: {
  session: TmuxSessionSummary;
  feed: SidecarDataSource;
  /** Its parent's place on the colour wheel, or nothing where the roster has not ranked it. */
  hue: number | undefined;
  /** This session's step on that parent's ladder, ranked over the parent's full roster. */
  step: number | undefined;
  /** Whether this is its parent's only session, in which case it gets no rail. */
  solo: boolean;
  open: boolean;
  onToggle: () => void;
  /** Takes this card off the strip. The session keeps running; the roster still lists it. */
  onHide: () => void;
  /**
   * Ends the session and everything running in it, then takes it off the strip.
   *
   * A promise because the card reports the failure where it was asked: a rejection renders on
   * this card rather than travelling anywhere.
   */
  onKill: () => Promise<void>;
}) {
  const shaded = terminalChildStyle(hue, step);
  const railed = shaded !== undefined && !solo;
  const [confirming, setConfirming] = useState(false);
  const [killing, setKilling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Brings this card into view when it BECOMES an open one, the same transition the Bot cards
  // scroll on: a card already open when it mounts is one the canvas is coming back to, and
  // scrolling there would drag the strip off the offset the reader left it at.
  const card = useRef<HTMLLIElement | null>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    const opened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opened) return;
    card.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [open]);

  const kill = (): void => {
    setKilling(true);
    setError(null);
    // Either end clears the confirm: success means the session is dying and the shell's refresh
    // takes the row with it, so leaving the dialog up would ask about something already gone.
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

  const items: RowMenuItem[] = [];
  if (open) items.push({ label: "Close terminal", icon: X, onSelect: onToggle });
  // Below the close and above the kill, widening from arranging the view to ending the work.
  items.push({ label: "Take off strip", icon: EyeOff, onSelect: onHide });
  items.push({ label: "Kill session", icon: Skull, onSelect: () => setConfirming(true) });

  const watched = session.attachedClients > 0
    ? `${session.attachedClients} watching`
    : "unattached";
  return (
    <li
      ref={card}
      className="shrink-0"
      // The Bot canvas's closed width, shared rather than repeated: a closed terminal row holds
      // the same anatomy a closed session row does -- a mark, a title, a meta line, a chevron and
      // a menu -- so the number that fits one fits the other, and the comment on it says when it
      // moves.
      style={{ width: open ? undefined : CLOSED_SESSION_WIDTH }}
    >
      <div
        className={`relative flex overflow-hidden rounded-lg border ${
          shaded
            ? `terminal-session-fill terminal-session-edge ${railed ? "terminal-rail" : ""}`
            : open
              ? "border-primary"
              : "border-border"
        }`}
        style={{
          ...shaded,
          ...(railed ? { borderLeftWidth: 4 } : null),
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-start pr-1.5">
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-2 py-2 pr-2 pl-1 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80"
            >
              {/* The mark, not a dot: initials on this session's own step of its parent's
                  colour, ringed while somebody is watching. Faces are the Bot canvas's answer
                  to which-session; letters are this one's, because a tmux name already is one. */}
              <span
                aria-hidden
                // The hue and the step ride down from the card's own style: `terminalChildStyle`
                // publishes both or neither, so this disc never resolves half a colour.
                className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-(length:--agent-panel-fs-sidebar-chip,11px) font-semibold ${
                  shaded
                    ? "terminal-session-accent text-foreground"
                    : "border border-border bg-muted text-muted-foreground"
                } ${session.attachedClients > 0 ? "ring-2 ring-green-500" : ""}`}
              >
                {sessionInitials(session.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground">
                  {session.name}
                </span>
                <span className="block truncate text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
                  {watched} · {session.windows} {session.windows === 1 ? "window" : "windows"}
                </span>
              </span>
              <ChevronDown
                className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
            <span className="mt-1">
              <RowMenu label={`${session.name} terminal`} items={items} />
            </span>
          </div>
          {confirming ? (
            <div
              role="alertdialog"
              aria-label={`Kill ${session.name}?`}
              className="border-t border-destructive/40 bg-destructive/10 px-3 py-2"
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
                  // `text-white`, because this theme names no `destructive-foreground`: the
                  // solid destructive button is the standard shadcn pairing either way.
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
              className="border-t border-destructive/40 bg-destructive/10 px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive"
            >
              {error}
            </p>
          ) : null}
          {open ? (
            // No landmark of its own: the tile below already names this session, and a section
            // inside a section under one name is a landmark that says nothing twice.
            <div className="min-h-0 border-t border-border">
              <TerminalTile feed={feed} session={session} />
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}
