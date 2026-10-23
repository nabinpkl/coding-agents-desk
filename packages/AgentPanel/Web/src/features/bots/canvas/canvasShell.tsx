// What every card on the canvas reads from the shell, handed to the cards directly rather than
// passed down through the strip.
//
// The commands and the per-card facts here are owned by the app's shell hooks (`useBotCommands`,
// `useCanvasRoster`, `useThreadSelection`), because the sidebar, the dialogs and the thread view act
// on the same Bots and read the same open cards. Before this they reached a session card as props of
// the canvas, the strip and the Bot card, none of which used them: each command was written three
// times per layer, and a new one meant editing four files. See ADR-0149.
//
// Two contexts, because the commands keep their identity across renders and the facts do not: a
// card that only issues commands is not re-rendered by a card opening somewhere else.

import { createContext, useContext, type ReactNode } from "react";
import type { AgentSessionDescriptor, BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SessionViewContext } from "@/features/session-view/SessionView";
import type { NewBotSession } from "@/features/bots/cards/BotNewSessionCard";
import type { SessionDraftControls } from "@/features/bots/cards/BotSessionDraftCard";
import type { BotCommandError } from "@/features/bots/cards/botCanvasCards";
import { CanvasStoreContext, type CanvasStore } from "@/features/bots/canvas/canvasStore";

/** Everything a card on the canvas can ask the shell to do. */
export interface CanvasActions {
  onAddSession: (bot: BotView) => void;
  /** Branches a new session from this one, in its own pane, and gives it to the Bot. */
  onForkSession: (bot: BotView, session: SessionSummary) => void;
  /** The same fork, starting just before the last thing a person said in that session. */
  onForkFromLastMessage: (bot: BotView, session: SessionSummary) => void;
  onForkFromLastCompaction: (bot: BotView, session: SessionSummary) => void;
  /** Opens the handover dialog for a Claude session. */
  onHandoverSession: (bot: BotView, session: SessionSummary) => void;
  /**
   * Binds a session one of a Bot's own sessions made (`/new`, `/fork`) to that Bot. A function of
   * the Bot, because the card is the only thing that knows which Bot a session belongs to.
   */
  attachSessionToBot: (bot: BotView) => (session: AgentSessionDescriptor) => void | Promise<void>;
  /** Opens the rename dialog for this session. Claude only; a Codex row does not offer it. */
  onRenameSession: (session: SessionSummary) => void;
  /**
   * Drops the reference from the Bot's projection. The session itself is untouched. A reference
   * rather than a summary, because the rows that most need this are the missing ones, which have no
   * summary left.
   */
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  /** Takes one session's card off this canvas; the Bot keeps its reference to it. */
  onRemoveSessionFromCanvas: (session: BotSessionRef) => void;
  /** Opens this session in the modal, over the canvas, without changing what the card shows. */
  onMaximizeSession: (bot: BotView, session: SessionSummary) => void;
  /** Takes the whole Bot off this canvas; the sidebar's roster is where it waits to come back. */
  onDetachBot: (bot: BotView) => void;
  /** Names a session the Bot's Father, or clears it with a null ref. */
  onSetFatherSession: (bot: BotView, session: BotSessionRef | null) => void;
  /** Opens the dialog that renames a Bot and restyles its face. */
  onRenameBot: (bot: BotView) => void;
  /** Forgets a Bot; its sessions survive. */
  onDeleteBot: (bot: BotView) => void;
  /**
   * Stands one Bot's sessions in a new order, naming the one carried. The whole order, because that
   * is what the Bot holds and the sidecar checks: see `botSessionOrder.ts`.
   */
  onReorderSessions: (bot: BotView, sessionRefs: BotSessionRef[], moved: BotSessionRef) => void;
  /** Opens that session's card, or closes it if it is open. */
  onToggleSession: (key: string) => void;
  /** Takes a started session's card away. The tmux session keeps running. */
  onCloseNewSession: (sessionId: string) => void;
  /** The ⋮ item that shows a session on the other canvas too, or back on this one only. */
  canvasShareFor: (bot: BotView, session: BotSessionRef) => { label: string; onSelect: () => void } | undefined;
}

/** What every card reads about the canvas as a whole, rather than about its own Bot. */
export interface CanvasCards {
  /**
   * The context ONE card renders its session in, by Bot. A resolver, because a Bot whose directory
   * is on a peer reads its transcripts and runs its commands through that peer's sidecar
   * (`botMachines.ts`).
   */
  sessionContextFor: (botId: string) => SessionViewContext;
  /** Which sessions are open, as `source:sessionId`. */
  openKeys: ReadonlySet<string>;
  /**
   * The sessions NOT on the canvas, as `source:sessionId`, whichever Bot holds them. Subtracted from
   * each card's roster rather than from the Bots, because a Bot with every session hidden is still
   * on the canvas: its header is where sessions are added.
   */
  detachedSessionKeys: ReadonlySet<string>;
  /** A failure from editing a Bot, shown on the card of the session it was about. */
  botError: BotCommandError | null;
  /**
   * Sessions this panel started that the catalog does not know yet. They cannot arrive on a Bot:
   * the sidecar refuses a reference to a session with no transcript, so each lives here until its
   * first turn writes one. See `BotNewSessionCard`.
   */
  newSessions: readonly NewBotSession[];
  /** Forks and fresh sessions on a Bot, waiting to be started from their own cards. */
  sessionDrafts: SessionDraftControls;
}

const ActionsContext = createContext<CanvasActions | null>(null);
const CardsContext = createContext<CanvasCards | null>(null);

/** Hands the canvas its store, its commands and its per-card facts. Rendered around `BotCanvas`. */
export function CanvasShell({
  store,
  actions,
  cards,
  children,
}: {
  store: CanvasStore;
  actions: CanvasActions;
  cards: CanvasCards;
  children: ReactNode;
}) {
  return (
    <CanvasStoreContext.Provider value={store}>
      <ActionsContext.Provider value={actions}>
        <CardsContext.Provider value={cards}>{children}</CardsContext.Provider>
      </ActionsContext.Provider>
    </CanvasStoreContext.Provider>
  );
}

export function useCanvasActions(): CanvasActions {
  const actions = useContext(ActionsContext);
  if (actions === null) throw new Error("A canvas card rendered outside CanvasShell");
  return actions;
}

export function useCanvasCards(): CanvasCards {
  const cards = useContext(CardsContext);
  if (cards === null) throw new Error("A canvas card rendered outside CanvasShell");
  return cards;
}
