import {
  ChevronDown,
  LoaderCircle,
  Plus,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { BotSessionRef, BotView, ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { ProfileRow } from "@/features/profile/ProfileRow";
import { BotSidebarPanel } from "@/features/bots/BotSidebarPanel";
import { BotCanvasStatus } from "@/features/bots/canvas/BotCanvasStatus";
import { MessagesPanel } from "@/features/messages/MessagesPanel";
import type { DesktopParkHandle } from "@/features/desktop-park/useDesktopPark";
import type { MessagesHandle } from "@/features/messages/useMessages";
import type { UsageHandle } from "@/features/usage/useUsage";
import { ActivityDot, SessionMeta } from "@/features/sidebar/SessionMeta";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { ProjectSidebarItem } from "@/features/sidebar/ProjectSidebarItem";
import { SidebarError, SidebarStatus } from "@/features/sidebar/SidebarStatusRows";


export type AgentSidebarMode = "sessions" | "bots" | "canvas" | "messages";

/**
 * Tab order, and the order the arrow keys walk.
 *
 * Canvas sits after Bots because it is derived from them: it is the same curated roster with the
 * "pick one" taken out. A reader who has not met it yet meets Bots first, which is the thing it is
 * a view of. Messages comes last because it is the only tab whose content did not come from this
 * machine: it is the hub's, across every machine, so it is the one a reader goes to rather than
 * reads past.
 */
const SIDEBAR_MODES: ReadonlyArray<{ mode: AgentSidebarMode; label: string }> = [
  { mode: "sessions", label: "Sessions" },
  { mode: "bots", label: "Bots" },
  { mode: "canvas", label: "Canvas" },
  { mode: "messages", label: "Messages" },
];

interface AgentSidebarProps {
  mode: AgentSidebarMode;
  onModeChange: (mode: AgentSidebarMode) => void;
  projects: ProjectSummary[];
  /**
   * Sessions for every expanded project, or no entry for one whose list has not
   * arrived yet.
   *
   * Passed in rather than fetched here: the projects and all their sessions ride one
   * stream, and a component that opened a subscription per expanded row is what made
   * the number of open connections a function of how much of the tree the reader had
   * unfolded.
   */
  sessionsByProject: ReadonlyMap<string, SessionSummary[]>;
  loading: boolean;
  error: string | null;
  retrying: boolean;
  selectedProjectPath: string | null;
  selectedSessionKey: string | null;
  creatingProjectPath: string | null;
  creationErrors: ReadonlyMap<string, string>;
  expandedProjectPaths: ReadonlySet<string>;
  onToggleProject: (projectPath: string) => void;
  onSelectSession: (project: ProjectSummary, session: SessionSummary) => void;
  onCreatePiSession: (project: ProjectSummary) => void;
  bots: BotView[];
  /** Which machine each Bot is on, empty when one. See `BotSidebarPanel`. */
  botMachineLabels: ReadonlyMap<string, string>;
  /**
   * The sidecar that owns a Bot's directory, by id, for the roster's terminal button.
   *
   * The canvas cards already carry their machine's feed in their session context; the roster rows
   * have no context, so the feed arrives this way instead. One function rather than a map because
   * the roster is a merge of several machines' and the owner is a lookup.
   */
  feedForBot: (botId: string) => SidecarDataSource;
  botsLoading: boolean;
  botsError: string | null;
  selectedBotId: string | null;
  onSelectBotSession: (bot: BotView, session: SessionSummary) => void;
  onAddBotSession: (bot: BotView) => void;
  onDetachBotSession: (bot: BotView, session: BotSessionRef) => void;
  /** Names a session the Bot's Father, or clears it with a null ref. */
  onSetFatherBotSession: (bot: BotView, session: BotSessionRef | null) => void;
  /** Opens the rename dialog for one session, from either Bots view. */
  onRenameSession: (session: SessionSummary) => void;
  /**
   * The Bots NOT currently on the canvas, by id.
   *
   * The same set the canvas subtracts by, rather than a second list computed here, so the roster
   * below and the cards on the canvas cannot disagree about which is which.
   */
  detachedBotIds: ReadonlySet<string>;
  onToggleBotOnCanvas: (bot: BotView) => void;
  /**
   * The Bots with no card because their MACHINE is hidden, whether or not they are also detached.
   *
   * A separate set from `detachedBotIds` because the two are different axes with different
   * controls: a detached Bot comes back from its own row, and this one comes back from the machine
   * chip above the roster. Merging them would put a Bot behind a control that cannot reach it.
   */
  machineHiddenBotIds: ReadonlySet<string>;
  /**
   * What the canvas is holding: how many Bots, on which machines, and the control that narrows it.
   *
   * It belongs to the Canvas tab rather than to the canvas because it is the same question this
   * roster already answers -- which Bots are on the canvas -- asked one level up, and because the
   * canvas is a horizontal strip where every row of chrome is a row its cards do not get.
   *
   * `total` is counted upstream rather than from `bots` and `detachedBotIds` here, so it and the
   * per-machine counts come off one list: they are the same number broken down, and two places
   * deriving it is how they would come to disagree. See `BotCanvasStatus`.
   */
  canvasMachines: {
    total: number;
    shown: number;
    machines: readonly { key: string; label: string }[];
    hidden: ReadonlySet<string>;
    countOf: (key: string) => number;
    onToggle: (key: string) => void;
    /** The canvas drawn small enough to see all of at once. See `BotCanvasStatus`. */
    zoom: { on: boolean; onToggle: () => void };
    /** How much room that fitted canvas is given to be scrolled around in, in pixels a side. */
    room: { size: number; onChange: (size: number) => void };
  };
  /**
   * The sessions NOT on the canvas, as `source:sessionId`.
   *
   * This roster is where they live while they are off it -- the cards subtract by the same set --
   * so a row here is dimmed rather than dropped, and clicking it is the way back.
   */
  detachedSessionKeys: ReadonlySet<string>;
  /** Which sessions the canvas has open, so this roster can mark the rows that opened them. */
  canvasOpenSessionKeys: ReadonlySet<string>;
  /**
   * Opens a session ON the canvas rather than in place of it.
   *
   * The distinction is the whole point of the canvas: picking a session here scrolls its card into
   * view and unfolds it there, leaving every other Bot on screen, rather than replacing the canvas
   * with a single thread the way the Bots tab does.
   */
  onOpenSessionOnCanvas: (bot: BotView, session: SessionSummary) => void;
  onAddBot: () => void;
  /** The inbox's data and writes. Owned by the app, so all three sidebar mounts share one poll. */
  messages: MessagesHandle;
  onClose?: () => void;
  ownsWindowTitlebar?: boolean;
  /** Drives the Profile section's Usage entry. Owned by the app, so all three sidebar mounts
   *  share one subscription rather than opening one each. */
  usage: UsageHandle;
  park: DesktopParkHandle;
}

/**
 * Bring a tab into the strip, and only if it is not already in it.
 *
 * The strip scrolls when the views stop fitting, and the selected tab is the one that has to be
 * readable: a reader who arrives at "Messages" and sees "Sessions" has been told the name and left
 * to guess the rest. But a tab that is already on screen is not a problem, and scrolling to it
 * anyway is not free -- `scrollIntoView` walks every scrollable ancestor, so an unconditional call
 * on every tab click disturbs containers that have nothing to do with the strip. `nearest` keeps
 * the movement small; measuring first keeps the call from happening at all.
 *
 * The first ancestor that clips horizontally is the strip, and a tab inside its box is inside the
 * strip. If nothing clips, the whole strip is on screen and there is nothing to reveal.
 */
function revealInStrip(tab: HTMLButtonElement | null | undefined): void {
  if (!tab) return;
  const tabBox = tab.getBoundingClientRect();
  for (let node = tab.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowX;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    const stripBox = node.getBoundingClientRect();
    if (tabBox.left >= stripBox.left && tabBox.right <= stripBox.right) return;
    tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    return;
  }
}

export function AgentSidebar(props: AgentSidebarProps) {
  const tabGroupId = useId();
  const tabId = (mode: AgentSidebarMode) => `${tabGroupId}-${mode}-tab`;
  const panelId = (mode: AgentSidebarMode) => `${tabGroupId}-${mode}-panel`;
  const tabRefs = useRef(new Map<AgentSidebarMode, HTMLButtonElement | null>());

  const revealSelectedTab = useCallback(() => {
    revealInStrip(tabRefs.current.get(props.mode));
  }, [props.mode]);

  // On mount as well as on selection: a reader who reloads with a view remembered has not clicked
  // anything, and the remembered view is the one that has to be on screen when they arrive.
  useEffect(() => {
    revealSelectedTab();
  }, [revealSelectedTab]);

  const selectMode = (mode: AgentSidebarMode, focus = false) => {
    props.onModeChange(mode);
    if (focus) {
      globalThis.requestAnimationFrame?.(() => tabRefs.current.get(mode)?.focus());
    }
    revealInStrip(tabRefs.current.get(mode));
  };

  // Roving by index rather than the two-way toggle this was when there were exactly two tabs:
  // a third made "left means the first one" wrong in both directions. Wrapping is the ARIA tabs
  // pattern, and it is what keeps the last tab one keystroke from the first.
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const current = SIDEBAR_MODES.findIndex((tab) => tab.mode === props.mode);
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = (current - 1 + SIDEBAR_MODES.length) % SIDEBAR_MODES.length;
    else if (event.key === "ArrowRight") next = (current + 1) % SIDEBAR_MODES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SIDEBAR_MODES.length - 1;
    if (next === null) return;
    event.preventDefault();
    selectMode(SIDEBAR_MODES[next].mode, true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-foreground">
      <div
        data-window-drag
        className={`flex min-h-11 shrink-0 items-center border-b border-border px-1.5${
          props.ownsWindowTitlebar ? " agent-window-titlebar-sidebar-leading" : ""
        }`}
      >
        {/* Four views fit a phone drawer at the default type size and stop fitting when the
            reader raises it or narrows the rail, so the strip scrolls rather than compressing the
            last tab into its own truncation. `selectMode` scrolls the chosen one into view. */}
        <div
          role="tablist"
          aria-label="Agent views"
          className="flex min-w-0 flex-1 self-stretch overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {SIDEBAR_MODES.map(({ mode, label }) => (
            <button
              key={mode}
              ref={(node) => { tabRefs.current.set(mode, node); }}
              id={tabId(mode)}
              type="button"
              role="tab"
              aria-selected={props.mode === mode}
              aria-controls={panelId(mode)}
              tabIndex={props.mode === mode ? 0 : -1}
              onClick={() => selectMode(mode)}
              onKeyDown={handleTabKeyDown}
              className={`flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-2 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/70 ${
                props.mode === mode
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {props.onClose ? (
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close agent navigation"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70"
          >
            <X className="size-5" aria-hidden />
          </button>
        ) : null}
      </div>

      {/* The bottom safe area is no longer spent here. It moved to the Profile row below, which is
          now what touches the home indicator; leaving it on the scroller would hold back a strip
          under a row that is already clear of it. */}
      {props.mode === "sessions" ? (
        <div
          id={panelId("sessions")}
          role="tabpanel"
          aria-labelledby={tabId("sessions")}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {props.loading ? (
            <SidebarStatus>Loading projects…</SidebarStatus>
          ) : props.error ? (
            <SidebarError message={`Projects unavailable: ${props.error}`} retrying={props.retrying} />
          ) : props.projects.length === 0 ? (
            <SidebarStatus>No projects yet</SidebarStatus>
          ) : (
            <ul role="list" aria-label="Projects">
              {props.projects.map((project) => (
                <ProjectSidebarItem
                  key={project.projectPath}
                  project={project}
                  sessions={props.sessionsByProject.get(project.projectPath)}
                  expanded={props.expandedProjectPaths.has(project.projectPath)}
                  active={props.selectedProjectPath === project.projectPath}
                  selectedSessionKey={
                    props.selectedProjectPath === project.projectPath
                      ? props.selectedSessionKey
                      : null
                  }
                  creating={props.creatingProjectPath === project.projectPath}
                  creationError={props.creationErrors.get(project.projectPath) ?? null}
                  onToggle={() => props.onToggleProject(project.projectPath)}
                  onSelectSession={(session) => props.onSelectSession(project, session)}
                  onCreatePiSession={() => props.onCreatePiSession(project)}
                />
              ))}
            </ul>
          )}
        </div>
      ) : props.mode === "canvas" ? (
        // The same roster the Bots tab shows, not a lesser copy of it: every Bot with its sessions,
        // its Add-sessions button and its row menus, plus one thing that only means anything here,
        // which is whether the Bot is on the canvas. A second, thinner list of names would have
        // been a second place to look for a Bot and a second thing to keep in step.
        <div
          id={panelId("canvas")}
          role="tabpanel"
          aria-labelledby={tabId("canvas")}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <BotSidebarPanel
            bots={props.bots}
            machineLabels={props.botMachineLabels}
            feedForBot={props.feedForBot}
            loading={props.botsLoading}
            error={props.botsError}
            // Marked from what the CANVAS has open, not from what the app has selected: over here
            // a highlighted row means "this is a card that is unfolded", and nothing on the canvas
            // is selected in the sense the other two tabs mean. Every Bot holding an open session
            // is marked, not the first one found, because the canvas opens as many as it is asked
            // to and a roster that marked one of them would be pointing at the wrong card.
            selectedBotIds={
              new Set(
                props.bots
                  .filter((bot) =>
                    bot.sessions.some((session) =>
                      props.canvasOpenSessionKeys.has(`${session.source}:${session.sessionId}`),
                    ),
                  )
                  .map((bot) => bot.botId),
              )
            }
            selectedSessionKeys={props.canvasOpenSessionKeys}
            onSelectSession={props.onOpenSessionOnCanvas}
            onAddSession={props.onAddBotSession}
            onRenameSession={props.onRenameSession}
            onDetachSession={props.onDetachBotSession}
            onSetFatherSession={props.onSetFatherBotSession}
            onAddBot={props.onAddBot}
            canvas={{
              detachedBotIds: props.detachedBotIds,
              machineHiddenBotIds: props.machineHiddenBotIds,
              detachedSessionKeys: props.detachedSessionKeys,
              onToggle: props.onToggleBotOnCanvas,
            }}
            // Nothing while the roster is still arriving or has failed: the panel below says both
            // of those itself, and a count of zero read as a canvas someone had emptied.
            status={
              props.botsLoading || props.botsError ? null : (
                <BotCanvasStatus
                  total={props.canvasMachines.total}
                  shown={props.canvasMachines.shown}
                  machines={props.canvasMachines.machines}
                  hidden={props.canvasMachines.hidden}
                  countOf={props.canvasMachines.countOf}
                  onToggle={props.canvasMachines.onToggle}
                  zoom={props.canvasMachines.zoom}
                  room={props.canvasMachines.room}
                />
              )
            }
          />
        </div>
      ) : props.mode === "bots" ? (
        <div
          id={panelId("bots")}
          role="tabpanel"
          aria-labelledby={tabId("bots")}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <BotSidebarPanel
            bots={props.bots}
            machineLabels={props.botMachineLabels}
            feedForBot={props.feedForBot}
            loading={props.botsLoading}
            error={props.botsError}
            // Singletons: this tab selects one session at a time. The panel takes sets because
            // it is the same one the canvas tab renders, and the canvas does not.
            selectedBotIds={new Set(props.selectedBotId ? [props.selectedBotId] : [])}
            selectedSessionKeys={new Set(props.selectedSessionKey ? [props.selectedSessionKey] : [])}
            onSelectSession={props.onSelectBotSession}
            onAddSession={props.onAddBotSession}
            onRenameSession={props.onRenameSession}
            onDetachSession={props.onDetachBotSession}
            onSetFatherSession={props.onSetFatherBotSession}
            onAddBot={props.onAddBot}
          />
        </div>
      ) : (
        <div
          id={panelId("messages")}
          role="tabpanel"
          aria-labelledby={tabId("messages")}
          className="flex min-h-0 flex-1 flex-col"
        >
          <MessagesPanel messages={props.messages} />
        </div>
      )}

      <ProfileRow usage={props.usage} park={props.park} />
    </div>
  );
}

interface AgentSidebarDialogProps extends AgentSidebarProps {
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onRequestClose: () => void;
}

export function AgentSidebarDialog({
  open,
  triggerRef,
  onRequestClose,
  ...sidebarProps
}: AgentSidebarDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else {
        dialog.removeAttribute("open");
        dialog.dispatchEvent(new Event("close"));
      }
    }
  }, [open]);

  const closeDialog = () => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close();
    else {
      dialog.removeAttribute("open");
      dialog.dispatchEvent(new Event("close"));
    }
  };

  const closeAndRestoreFocus = () => {
    onRequestClose();
    globalThis.requestAnimationFrame?.(() => triggerRef.current?.focus());
  };

  // The drawer is the compact-layout agent navigation, so it only ever renders on the phone,
  // where it is also the one surface the app shell's safe-area padding cannot reach: `showModal`
  // puts it in the top layer, a sibling of the tree that pays for the edges. It sits against the
  // leading edge, so it pays for that one itself; the bottom is paid inside, by the scroller, so
  // the list can still be scrolled through the strip the home indicator sits on.
  return (
    <dialog
      ref={dialogRef}
      aria-label="Agent navigation"
      className="agent-sidebar-dialog fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(88vw,320px)] max-w-none border-0 border-r border-border bg-card p-0 pl-[env(safe-area-inset-left)] text-foreground shadow-2xl"
      onClose={closeAndRestoreFocus}
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <AgentSidebar
        {...sidebarProps}
        onClose={closeDialog}
        ownsWindowTitlebar
      />
    </dialog>
  );
}
