import { Check, ChevronDown } from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { DirectoryEntry } from "@agentdesk/agent-feed-wire";
import {
  BOTS_SECTION,
  recipientGroups,
  runtimesOf,
  SESSIONS_SECTION,
  type RecipientGroup,
} from "@/features/messages/hubRuntime";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { overlayHost, useDismissOnOutsidePress, useOverlayPlacement } from "@/hooks/dom/overlays";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useStateFor } from "@/hooks/state/useStateFor";

/** The gap this panel keeps between itself and the edge of the window. */
const MARGIN = 8;
/** The gap between the trigger and the panel. */
const GAP = 4;
/** The most it will ever be tall, however much room the window has. */
const MAX_HEIGHT = 420;
/** The most room a row's text gets before the panel is wider than the rail. */
const MAX_WIDTH = 520;

interface Placement {
  top: number;
  left: number;
  maxHeight: number;
}

/** The overflow values that clip a child, named rather than everything-but-`visible`. */
function clips(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll" || overflow === "hidden";
}

/** Whether the trigger is still inside every ancestor that clips it. See `RowMenu` for why. */
function triggerIsVisible(button: HTMLElement): boolean {
  const rect = button.getBoundingClientRect();
  for (let node = button.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (!clips(style.overflowY) && !clips(style.overflowX)) continue;
    const box = node.getBoundingClientRect();
    // A clipping ancestor with no area is not evidence of anything. It measures that way only
    // part way through a reflow -- a window being resized, a screenshot forcing the layout to a
    // size it passes through on the way somewhere else -- and reading "the trigger is outside
    // this" off it closes the panel over a filter the reader was still typing.
    if (!(box.width > 0) || !(box.height > 0)) continue;
    if (rect.bottom < box.top || rect.top > box.bottom) return false;
    if (rect.right < box.left || rect.left > box.right) return false;
  }
  return true;
}

/**
 * Where to put the panel, against the WINDOW.
 *
 * Below the trigger while it fits, above it when the window has more room above, and clamped on
 * both axes so a trigger at any edge still gets a panel on screen. `maxHeight` is what makes the
 * list scroll rather than run off the screen: the panel is told how much room it actually has in
 * the direction it chose, so a rail near the bottom of the window is a shorter panel, not a taller
 * one with its options off screen.
 */
function placePanel(trigger: DOMRect, panel: DOMRect): Placement {
  const viewportHeight = globalThis.innerHeight || 0;
  const viewportWidth = globalThis.innerWidth || 0;
  const below = viewportHeight - trigger.bottom - MARGIN - GAP;
  const above = trigger.top - MARGIN - GAP;
  const upward = panel.height > below && above > below;
  const available = Math.max(160, Math.min(MAX_HEIGHT, upward ? above : below));
  const width = Math.min(MAX_WIDTH, viewportWidth - MARGIN * 2);
  const top = upward
    ? Math.max(MARGIN, trigger.top - GAP - Math.min(panel.height, available))
    : Math.min(trigger.bottom + GAP, viewportHeight - MARGIN - Math.min(panel.height, available));
  return {
    top,
    // Left-aligned to the trigger, which is the edge a reader aims at, and clamped so the panel
    // never runs past the right edge on a rail near it.
    left: Math.max(MARGIN, Math.min(trigger.left, viewportWidth - MARGIN - width)),
    maxHeight: available,
  };
}

/** One row, flattened out of the groups so the keyboard can walk them in the order they are read. */
interface Row {
  entry: DirectoryEntry;
  groupIndex: number;
  indexInGroup: number;
}

function flatten(groups: RecipientGroup[]): Row[] {
  const rows: Row[] = [];
  groups.forEach((group, groupIndex) => {
    group.entries.forEach((entry, indexInGroup) => rows.push({ entry, groupIndex, indexInGroup }));
  });
  return rows;
}

/** Does this entry match what the reader typed? Name, group heading and machine, case-blind. */
function matches(entry: DirectoryEntry, group: RecipientGroup, query: string): boolean {
  if (query === "") return true;
  const needle = query.toLowerCase();
  return (
    entry.name.toLowerCase().includes(needle) ||
    group.label.toLowerCase().includes(needle) ||
    (entry.machine ?? "").toLowerCase().includes(needle) ||
    (entry.cwd ?? "").toLowerCase().includes(needle)
  );
}

interface SessionPickerProps {
  entries: DirectoryEntry[];
  /** The chosen address, or null. */
  value: string | null;
  onChange: (entry: DirectoryEntry) => void;
}

/**
 * Choosing the session to send to, as a panel over the rail rather than a `<select>`.
 *
 * A native select cannot nest: it renders an `<optgroup>` label as one flat line, so the two
 * sections and the group under each had to be spelled into a single string, and sixty-one rows
 * arrived as one unscrolling list with no way to narrow it. This panel is the two sections the
 * picker is actually two of, each with its own groups, scrollable, and filtered by what the reader
 * remembers about a session -- its name, its Bot, its machine or its directory.
 *
 * Portalled into `document.body` and measured against the window, the same reasoning as `RowMenu`:
 * the rail is a resizable, clipping box, and a popup inside it would be cut off at its edge. Into
 * the open `<dialog>` instead when the picker is in one, the phone's drawer (`overlayHost`). Focus
 * goes to the filter on open and back to the trigger on close, Escape closes without choosing, and
 * the arrow keys walk the visible rows with the active one scrolled into view.
 */
export function SessionPicker({ entries, value, onChange }: SessionPickerProps) {
  const [open, setOpen] = useState(false);
  /** Where the list is portalled, chosen as it opens: see `overlayHost`. */
  const [host, setHost] = useState<HTMLElement | null>(null);
  // The filter, the highlighted row and the placement belong to one opening of the list.
  const [query, setQuery] = useStateFor(open, () => "");
  const [active, setActive] = useStateFor(open, () => 0);
  const [placement, setPlacement] = useStateFor<Placement | null>(open, () => null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  const all = useMemo(() => recipientGroups(entries), [entries]);
  const groups = useMemo(
    () =>
      all
        .map((group) => ({ ...group, entries: group.entries.filter((entry) => matches(entry, group, query)) }))
        .filter((group) => group.entries.length > 0),
    [all, query],
  );
  const rows = useMemo(() => flatten(groups), [groups]);
  /** Where each session sits in the flat order, so a row's index is a lookup rather than a scan. */
  const indexOf = useMemo(() => new Map(rows.map((row, index) => [row.entry.address, index])), [rows]);

  const chosen = entries.find((entry) => entry.address === value) ?? null;
  const chosenRuntimes = chosen ? runtimesOf(chosen) : [];

  useDismissOnOutsidePress(open, [panel, trigger], () => setOpen(false));
  useDomSync(() => {
    if (open) filter.current?.focus();
  }, [open]);

  /**
   * Re-measure against the window, and only give up if the trigger has genuinely gone.
   *
   * `scrolled` is the difference between the two callers, and it is the whole point. A scroll can
   * carry the trigger out from under a clipping ancestor, and then a panel anchored to it is
   * floating over content it has nothing to do with, so that case can close. A resize cannot: this
   * trigger is the composer's own row, pinned to the bottom of the rail, and no scroll ever moves
   * it. Closing on resize threw away a reader's half-typed filter every time the window changed
   * shape, which is a real thing a person does while narrowing sixty rows. So a resize re-places
   * and clamps instead, and the panel is dropped only when the trigger is gone from the document --
   * a closed rail or a switched tab, both of which unmount it.
   */
  const reposition = useCallback(
    (scrolled: boolean) => {
      const button = trigger.current;
      const popup = panel.current;
      if (!button || !popup) return;
      if (!button.isConnected) {
        setOpen(false);
        return;
      }
      if (scrolled && !triggerIsVisible(button)) {
        // One frame of "not visible" is not the same as gone. A window reflow, a scrollbar appearing
        // or a drag on the rail edge all measure an ancestor at nothing for a frame on the way to
        // somewhere perfectly visible, and closing on that measurement threw away a filter the
        // reader had not finished typing. So the close waits for the layout to settle and only
        // happens if the trigger is still out of sight once it has. The fallback is for the sake of
        // a host without animation frames: better to close on the first reading than never to close.
        const settled = () => {
          const after = trigger.current;
          if (after && (!after.isConnected || !triggerIsVisible(after))) setOpen(false);
        };
        if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(settled);
        else globalThis.setTimeout(settled, 0);
        return;
      }
      setPlacement(placePanel(button.getBoundingClientRect(), popup.getBoundingClientRect()));
    },
    [setPlacement],
  );

  useOverlayPlacement(open, (cause) => reposition(cause !== "resize"), [groups]);

  // The active row is kept in view as the arrow keys move it, which is the half of a listbox the
  // browser does not do for a filtered set it never sees.
  useDomSync(() => {
    if (!open) return;
    const node = list.current?.querySelector<HTMLElement>(`#${CSS.escape(`${listId}-opt-${active}`)}`);
    node?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) globalThis.requestAnimationFrame?.(() => trigger.current?.focus());
  };

  const choose = (row: Row) => {
    onChange(row.entry);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (rows.length === 0 ? 0 : (current + 1) % rows.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (rows.length === 0 ? 0 : (current - 1 + rows.length) % rows.length));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, rows.length - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active];
      if (row) choose(row);
    }
  };

  const sections = [
    { name: BOTS_SECTION, groups: groups.filter((group) => group.label.startsWith(BOTS_SECTION)) },
    { name: SESSIONS_SECTION, groups: groups.filter((group) => group.label.startsWith(SESSIONS_SECTION)) },
  ].filter((section) => section.groups.length > 0);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={(event) => {
          setHost(overlayHost(event.currentTarget));
          setOpen((current) => !current);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-body,15px)">
          {chosen ? chosen.name : <span className="text-muted-foreground">Pick a session</span>}
        </span>
        {chosenRuntimes.map((runtime) => (
          <span key={runtime} className="shrink-0">
            <SourceBadge source={runtime} />
          </span>
        ))}
        {chosen && chosen.reachability !== "reachable" ? (
          <span className="shrink-0 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
            no live session
          </span>
        ) : null}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {open && host
        ? createPortal(
            <div
              ref={panel}
              style={{
                top: placement?.top ?? 0,
                left: placement?.left ?? 0,
                maxHeight: placement?.maxHeight ?? MAX_HEIGHT,
                visibility: placement ? undefined : "hidden",
              }}
              className="fixed z-50 flex w-80 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
              data-portal-menu=""
              onKeyDown={onKeyDown}
            >
              <div className="flex shrink-0 items-center border-b border-border px-3">
                <label className="sr-only" htmlFor={`${listId}-filter`}>
                  Filter sessions
                </label>
                <input
                  id={`${listId}-filter`}
                  ref={filter}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                  placeholder="Filter by name, Bot or directory"
                  className="min-h-10 w-full bg-transparent text-(length:--agent-panel-fs-sidebar-body,15px) outline-none placeholder:text-muted-foreground"
                />
              </div>
              <div
                ref={list}
                id={listId}
                role="listbox"
                aria-label="Sessions to send to"
                aria-activedescendant={rows[active] ? `${listId}-opt-${active}` : undefined}
                tabIndex={-1}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
              >
                {rows.length === 0 ? (
                  <p className="px-3 py-6 text-center text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
                    No session matches “{query}”
                  </p>
                ) : null}
                {sections.map((section) => (
                  <div key={section.name} role="group" aria-label={section.name}>
                    <p className="px-3 pt-2 pb-1 text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium uppercase tracking-wide text-muted-foreground">
                      {section.name}
                    </p>
                    {section.groups.map((group) => (
                      <div key={group.label} role="group" aria-label={group.label}>
                        <p className="px-3 py-1 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground/80">
                          {group.label.slice(section.name.length + 3)}
                        </p>
                        {group.entries.map((entry) => {
                          const index = indexOf.get(entry.address) ?? 0;
                          const isActive = index === active;
                          const isChosen = entry.address === value;
                          return (
                            <div
                              key={entry.address}
                              id={`${listId}-opt-${index}`}
                              role="option"
                              aria-selected={isChosen}
                              onClick={() => choose(rows[index]!)}
                              onPointerMove={() => setActive(index)}
                              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 outline-none ${
                                isActive ? "bg-accent text-accent-foreground" : ""
                              }`}
                            >
                              <Check className={`size-3.5 shrink-0 ${isChosen ? "" : "invisible"}`} aria-hidden />
                              <span className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-body,15px)">
                                {entry.name}
                              </span>
                              {entry.reachability === "reachable" ? null : (
                                <span className="shrink-0 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
                                  no live session
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>,
            host,
          )
        : null}
    </>
  );
}
