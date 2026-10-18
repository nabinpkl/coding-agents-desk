import type { AgentSessionDescriptor, BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SessionViewContext } from "@/features/session-view/SessionView";
import type { NewBotSession } from "@/features/bots/cards/BotNewSessionCard";
import type { ForkDraftControls } from "@/features/bots/cards/BotForkDraftCard";
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
  sessionContextFor,
  machines,
  keyOfBot,
  hiddenMachines,
  machineErrors,
  botError,
  onAddSession,
  onForkSession,
  attachSessionToBot,
  onForkFromLastMessage,
  onForkFromLastCompaction,
  onHandoverSession,
  onRenameSession,
  onDetachSession,
  onRemoveSessionFromCanvas,
  onMaximizeSession,
  onDetachBot,
  onSetFatherSession,
  onRenameBot,
  onDeleteBot,
  onMoveBot,
  onReorderSessions,
  detachedCount,
  detachedSessionKeys,
  openKeys,
  onToggleSession,
  onAddBot,
  newSessions,
  onCloseNewSession,
  forkDrafts,
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
   * Everything an opened row's session needs that is not the session, built once by the shell.
   * The same object the thread view is given, which is what makes a row here the same surface
   * rather than a lesser copy of it.
   */
  /**
   * The context ONE card renders its session in, by Bot.
   *
   * A resolver rather than a context, because the canvas is the surface that shows several machines
   * at once: a Bot whose directory is on a peer must read its transcripts, run its commands and
   * open its terminals through that peer's sidecar. See `botMachines.ts`. A single-machine panel
   * gets the same object back for every Bot, so nothing here notices.
   */
  sessionContextFor: (botId: string) => SessionViewContext;
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
  /**
   * A failure from editing a Bot, shown on the card of the session it was about.
   *
   * This surface is where a detach is most likely to be pressed -- the action is in every row's
   * menu -- so the card that failed to go away is what says so. One about no session, or about a
   * session this canvas is not showing, goes to the canvas's own band instead.
   */
  botError: BotCommandError | null;
  onAddSession: (bot: BotView) => void;
  /** Branches a new session from this one, in its own pane, and gives it to the Bot. */
  onForkSession: (bot: BotView, session: SessionSummary) => void;
  /** A function of the Bot: the card is the only thing that knows which one it belongs to. */
  attachSessionToBot: (bot: BotView) => (session: AgentSessionDescriptor) => void | Promise<void>;
  /** The same fork, starting just before the last thing a person said in that session. */
  onForkFromLastMessage: (bot: BotView, session: SessionSummary) => void;
  onForkFromLastCompaction: (bot: BotView, session: SessionSummary) => void;
  onHandoverSession: (bot: BotView, session: SessionSummary) => void;
  /** Opens the rename dialog for this session. Claude only; a Codex row does not offer it. */
  onRenameSession: (session: SessionSummary) => void;
  /**
   * Drops the reference from the Bot's projection. The session itself is untouched.
   *
   * Takes a reference rather than a summary because the rows that most need this are the ones with
   * no summary left: a transcript the catalog has forgotten shows as "missing" and would otherwise
   * be the one entry a Bot can never be rid of.
   */
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  /**
   * Takes one session's card off this canvas, leaving the Bot's reference to it alone.
   *
   * Takes no Bot, unlike the removal above it, because the answer is not a fact about a Bot: the
   * canvas hides a session, and a session belongs to one Bot at a time, so its key is the whole
   * address.
   */
  onRemoveSessionFromCanvas: (session: BotSessionRef) => void;
  /** Opens this session in the modal, over the canvas, without changing what the card shows. */
  onMaximizeSession: (bot: BotView, session: SessionSummary) => void;
  /**
   * Takes the whole Bot off this canvas. The Bot, its curated sessions and their transcripts are
   * untouched -- this arranges the view, and the sidebar's canvas panel is where it waits to come
   * back.
   */
  onDetachBot: (bot: BotView) => void;
  /** Names a session the Bot's Father, or clears it with a null ref. */
  onSetFatherSession: (bot: BotView, session: BotSessionRef | null) => void;
  /** Opens the dialog that renames a Bot and restyles its face. */
  onRenameBot: (bot: BotView) => void;
  /** Forgets a Bot; its sessions survive. */
  onDeleteBot: (bot: BotView) => void;
  /**
   * Stands one Bot's sessions in a new order, naming the one carried. A Bot command rather than an
   * arrangement of this canvas: that order is the Bot's own and reaches every surface reading it.
   */
  onReorderSessions: (bot: BotView, sessionRefs: BotSessionRef[], moved: BotSessionRef) => void;
  /** Stands one Bot where another stands. By id; see `moveBot` in `useCanvasRoster`. */
  onMoveBot: (moved: string, target: string) => void;
  /**
   * How many Bots exist but are off the canvas, which is only ever asked when `bots` is empty. An
   * empty canvas that says "No bots yet" over a roster of eight is a lie, and would send the reader
   * to Add Bot rather than to the roster their Bots are already in.
   */
  detachedCount: number;
  /**
   * The sessions NOT on the canvas, as `source:sessionId`, whichever Bot holds them.
   *
   * Subtracted from each card's roster rather than from `bots`, because a Bot with every session
   * hidden is still a Bot on the canvas: its header is where sessions are added, and dropping the
   * card would take away the way back to a Bot the reader only meant to tidy.
   */
  detachedSessionKeys: ReadonlySet<string>;
  /**
   * Which sessions are open, as `source:sessionId`, owned above this component.
   *
   * It used to live in `BotCanvasList`, and it moved out when the sidebar beside the canvas gained
   * the same rows: a session picked over there opens the card over here, which cannot work while
   * the only copy of the answer is inside the thing being driven.
   */
  openKeys: ReadonlySet<string>;
  /** Opens that session, or closes it if it is already open. */
  onToggleSession: (key: string) => void;
  onAddBot: () => void;
  /**
   * Sessions this panel has started that the catalog does not know yet.
   *
   * They cannot arrive through `bots` and that is not an omission: a Bot curates references the
   * sidecar resolved, and the sidecar refuses a reference to a session with no transcript. So a
   * session lives here from the moment it is started until its first turn writes one, at which
   * point the shell attaches it and it becomes an ordinary row on its Bot. See `BotNewSessionCard`.
   */
  newSessions: readonly NewBotSession[];
  /** Takes the card away. The tmux session keeps running; nothing was attached to detach. */
  onCloseNewSession: (sessionId: string) => void;
  /** Forks onto a Bot waiting to be started from their own cards (`BotForkDraftCard`). */
  forkDrafts: ForkDraftControls;
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
        sessionContextFor={sessionContextFor}
        machines={machines}
        keyOfBot={keyOfBot}
        hiddenMachines={hiddenMachines}
        machineErrors={machineErrors}
        botError={botError}
        onAddSession={onAddSession}
        onForkSession={onForkSession}
        attachSessionToBot={attachSessionToBot}
        onForkFromLastMessage={onForkFromLastMessage}
        onForkFromLastCompaction={onForkFromLastCompaction}
        onHandoverSession={onHandoverSession}
        onRenameSession={onRenameSession}
        onDetachSession={onDetachSession}
        onRemoveSessionFromCanvas={onRemoveSessionFromCanvas}
        onMaximizeSession={onMaximizeSession}
        onDetachBot={onDetachBot}
        onSetFatherSession={onSetFatherSession}
        onRenameBot={onRenameBot}
        onDeleteBot={onDeleteBot}
        onReorderSessions={onReorderSessions}
        onMoveBot={onMoveBot}
        detachedSessionKeys={detachedSessionKeys}
        openKeys={openKeys}
        onToggleSession={onToggleSession}
        newSessions={newSessions}
        onCloseNewSession={onCloseNewSession}
        forkDrafts={forkDrafts}
        canvasZoom={canvasZoom}
      />
    </div>
  );
}
