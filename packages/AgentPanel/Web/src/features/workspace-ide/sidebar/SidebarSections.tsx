// The sections a file sidebar switches between: the explorer tree, text search, and source
// control. Search is the IDE's alone; a Bot's code modal shows the other two.
//
// Icons rather than words, with the changed-file count riding the Source Control tab so it is
// readable from the Explorer. The IDE's sidebar and a Bot's code modal both switch with this, so
// the two read the same wherever a reader meets them.

import { ArrowDownAZ, ClockArrowDown, FolderTree, GitBranch, Search } from "lucide-react";
import { changedLabel } from "@/features/workspace-ide/sidebar/gitTones";
import type { TreeOrder } from "@/features/workspace-ide/sidebar/treeOrder";

export type SidebarSection = "explorer" | "search" | "sourceControl";

const SECTIONS: { id: SidebarSection; label: string; shortcut?: string; Icon: typeof FolderTree }[] = [
  { id: "explorer", label: "Explorer", Icon: FolderTree },
  // The shortcut rides the hover title only: read aloud, "shift command F" is noise in a name.
  { id: "search", label: "Search", shortcut: "⇧⌘F", Icon: Search },
  { id: "sourceControl", label: "Source Control", Icon: GitBranch },
];

/**
 * The two orders the explorer draws its rows in, as the pair a reader chooses between.
 *
 * Both are on screen rather than one button that toggles, because a toggle has to be read as "the
 * icon says which order this is" or "the icon says what pressing it will do", and only one of those
 * is true at a time. Two labelled buttons answer both, and which one is pressed is the state.
 */
const ORDERS: { id: TreeOrder; label: string; Icon: typeof FolderTree }[] = [
  { id: "name", label: "Sort by name", Icon: ArrowDownAZ },
  { id: "modified", label: "Sort by modified date", Icon: ClockArrowDown },
];

const CONTROL = "relative grid h-7 w-8 place-items-center rounded-md outline-none transition-colors"
  + " focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
  + " disabled:cursor-not-allowed disabled:opacity-40";

/**
 * The count rides the tab, so the number of changed files is readable from the Explorer.
 *
 * Filled rather than tinted, unlike the per-section counts inside Source Control: those label a
 * group the reader is already looking at, and this one has to be seen from the other section.
 */
const BADGE = "pointer-events-none absolute -bottom-0.5 -right-0.5 min-w-[14px] rounded-full"
  + " bg-primary px-1 text-center font-mono text-[9px] leading-[14px] text-primary-foreground";

export function SidebarSections({
  label,
  section,
  changed,
  sourceControlUnavailable,
  searchable = false,
  order,
  onOrderChange,
  onSelect,
}: {
  /** Names the strip for a screen reader, which meets more than one on a page. */
  label: string;
  section: SidebarSection;
  /** How many files have uncommitted changes. */
  changed: number;
  /** Why there is no source control to show, when there is none: a directory outside git. */
  sourceControlUnavailable?: string;
  /** Whether text search is offered. A Bot's read-only code modal does not have one. */
  searchable?: boolean;
  /**
   * The order the explorer's rows are in, and the control that changes it.
   *
   * Both absent wherever the section on screen has no tree to reorder, rather than drawn disabled:
   * a control that cannot do anything is a question nobody asked. A Bot's code modal shows the
   * explorer with no arrangement to remember, so it gets neither.
   */
  order?: TreeOrder;
  onOrderChange?: (order: TreeOrder) => void;
  onSelect: (section: SidebarSection) => void;
}) {
  return (
    <nav
      aria-label={label}
      className="flex shrink-0 items-center gap-1 border-b border-border px-1.5 py-1"
    >
      {SECTIONS.filter(({ id }) => searchable || id !== "search").map(({ id, label: name, shortcut, Icon }) => {
        const selected = id === section;
        const count = id === "sourceControl" ? changed : 0;
        const unavailable = id === "sourceControl" ? sourceControlUnavailable : undefined;
        return (
          <button
            key={id}
            type="button"
            // The name is gone from the pixels but not from the surface: the label carries it to
            // a screen reader and the title brings it back on hover. The count goes in both,
            // because the badge that carries it is a glyph to everything but the eye.
            aria-label={count > 0 ? `Show ${name}, ${changedLabel(count)}` : `Show ${name}`}
            aria-pressed={selected}
            title={unavailable
              ?? (count > 0 ? `${name} (${changedLabel(count)})` : shortcut ? `${name} (${shortcut})` : name)}
            disabled={unavailable !== undefined}
            onClick={() => onSelect(id)}
            className={`${CONTROL} ${selected
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
          >
            <Icon className="size-4" />
            {/* Capped, because the badge sits on a 32px button and a four-digit count would
                cover the glyph it is annotating. */}
            {count > 0
              ? <span aria-hidden className={BADGE}>{count > 99 ? "99+" : count}</span>
              : null}
          </button>
        );
      })}

      {/* Its own group at the far end, divided from the section tabs: these two do not switch
          what is on screen, they change how the thing already on screen is listed. */}
      {onOrderChange && order
        ? (
          <div
            role="group"
            aria-label="Row order"
            className="ml-auto flex items-center gap-0.5 border-l border-border pl-1.5"
          >
            {ORDERS.map(({ id, label: name, Icon }) => (
              <button
                key={id}
                type="button"
                aria-label={name}
                aria-pressed={order === id}
                title={name}
                onClick={() => onOrderChange(id)}
                className={`${CONTROL} ${order === id
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
              >
                <Icon className="size-4" />
              </button>
            ))}
          </div>
        )
        : null}
    </nav>
  );
}
