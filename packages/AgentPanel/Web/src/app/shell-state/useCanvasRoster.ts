// What the reader arranged on the canvas: which Bots are on it, which sessions are open, and which
// machines it is showing at all.
//
// Four sets and the order they stand in, all held above the canvas rather than inside it -- the
// sidebar's roster puts a Bot back, opens a card and lists them in that same order, and a picker
// cannot drive state that lives inside the thing it is driving.
//
// Which Bots and sessions are ON the canvas, and the order the Bots stand in, are not the browser's
// to remember: they are on each Bot's record in its machine's `bots.json` (`offCanvas`,
// `offCanvasSessionRefs`, `canvasPosition`), read here off the roster and changed with
// `setBotCanvas`. The rest is how this reader arranged this browser, and `botCanvasPreferences`
// keeps it.

import { useCallback, useMemo, useState } from "react";
import type { AgentSessionDescriptor, BotSessionRef, BotView, SessionSummary, SetBotCanvasCommand } from "@agentdesk/agent-feed-wire";
import type { BotFeeds } from "@/features/bots/botMachines";
import type { BotCommandError } from "@/features/bots/canvas/BotCanvas";
import {
  botCanvasOrderOf,
  botCanvasPositionOrder,
  loadCanvasOpenKeys,
  loadCanvasOpenMachines,
  loadCanvasRoom,
  loadHiddenMachines,
  moveInOrder,
  orderBotsForCanvas,
  storeCanvasOpenKeys,
  storeCanvasOpenMachines,
  storeCanvasRoom,
  storeHiddenMachines,
} from "@/features/bots/canvas/botCanvasPreferences";
import { loadCanvasZoomMode, storeCanvasZoomMode } from "@/features/bots/canvas/useCanvasZoom";
import { usePersistentState } from "@/hooks/state/usePersistentState";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useNotify } from "@/hooks/useNotify";

export function useCanvasRoster(
  botsState: {
    bots: BotView[];
    /** Every machine's roster has arrived. See the prune below for why "not failing" is not enough. */
    settled: boolean;
    /**
     * Which machine each Bot is on, as its machine key. Absent where there is only ever one. A map
     * rather than a lookup, because the prune below decides during render and has to see a Bot
     * that arrived in this render.
     */
    machineKeys?: ReadonlyMap<string, string>;
    /**
     * The machines the roster covers right now, by key, or absent when the embedder names none and
     * this sidecar is the only one there can be. A peer that misses its heartbeat leaves this list.
     */
    machines?: readonly string[];
  },
  /** Which machine's sidecar holds each Bot's record, and so its place on the canvas. */
  feeds: BotFeeds,
) {
  // What is off the canvas: whole Bots by id, then single sessions as `source:sessionId`. Derived
  // from the records on every snapshot rather than held, so there is no second copy to drift.
  const detachedBotIds = useMemo<ReadonlySet<string>>(
    () => new Set(botsState.bots.filter((bot) => bot.offCanvas).map((bot) => bot.botId)),
    [botsState.bots],
  );
  const detachedSessionKeys = useMemo<ReadonlySet<string>>(
    () => new Set(botsState.bots.flatMap((bot) =>
      (bot.offCanvasSessionRefs ?? []).map((ref) => `${ref.source}:${ref.sessionId}`))),
    [botsState.bots],
  );
  // Every session some Bot holds, on any machine, which is what "Move to canvas" is not offered on.
  const heldSessionKeys = useMemo<ReadonlySet<string>>(
    () => new Set(botsState.bots.flatMap((bot) => bot.sessionRefs.map((ref) => `${ref.source}:${ref.sessionId}`))),
    [botsState.bots],
  );
  // Read through a ref so the commands below keep one identity while the roster moves under them.
  const currentBots = useLatestRef(botsState.bots);
  /**
   * A canvas change that did not land. Said on the canvas rather than swallowed: nothing moves
   * until the sidecar has written it, so a failure would otherwise look like a click that did
   * nothing.
   */
  const [canvasError, setCanvasError] = useState<BotCommandError | null>(null);
  /**
   * Writes a Bot's place on the canvas to its record. Nothing is set here on success: the Bot
   * stream publishes the new snapshot and the sets above follow it, on this surface and every
   * other one reading that machine.
   */
  const setBotCanvas = useCallback(async (
    botId: string,
    command: SetBotCanvasCommand,
    session: string | null = null,
  ): Promise<boolean> => {
    setCanvasError(null);
    try {
      await feeds.forBot(botId).setBotCanvas(botId, command);
      return true;
    } catch (error) {
      const name = currentBots.current.find((bot) => bot.botId === botId)?.name ?? botId;
      setCanvasError({
        session,
        message: `Could not change ${name} on the canvas: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return false;
    }
  }, [feeds, currentBots]);
  /** Puts a Bot back if it was off. What starting a session in it does, so the new card shows. */
  const putBotOnCanvas = useCallback((botId: string) => {
    const bot = currentBots.current.find((each) => each.botId === botId);
    if (bot?.offCanvas) void setBotCanvas(botId, { onCanvas: true });
  }, [setBotCanvas, currentBots]);
  const removeSessionFromCanvas = useCallback((session: BotSessionRef) => {
    const key = `${session.source}:${session.sessionId}`;
    const change = { source: session.source, sessionId: session.sessionId, onCanvas: false };
    // Every Bot holding it, since the key is what the canvas hides by.
    for (const bot of currentBots.current) {
      if (bot.sessionRefs.some((ref) => `${ref.source}:${ref.sessionId}` === key)) {
        void setBotCanvas(bot.botId, { sessions: [change] }, key);
      }
    }
  }, [setBotCanvas, currentBots]);
  // Which sessions the canvas has open, as `source:sessionId`. Held here rather than inside the
  // canvas because the sidebar's roster opens cards too, and a picker cannot drive state that lives
  // inside the thing it is driving.
  const [canvasOpenKeys, setCanvasOpenKeys] = usePersistentState<ReadonlySet<string>>(loadCanvasOpenKeys, storeCanvasOpenKeys);
  const toggleCanvasSession = useCallback((key: string) => {
    setCanvasOpenKeys((current) => {
      // A new set rather than a mutation, because React decides whether to re-render by identity.
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, [setCanvasOpenKeys]);
  // One write for every way the open cards change -- a row's own toggle, the sidebar roster opening
  // one, a Bot leaving the canvas -- from the setter, rather than a call beside each of them, which
  // is how one of them ends up forgotten.
  // And one prune, because an open key is an address that nothing resolved: a key naming a session
  // no Bot holds any more opened nothing, went unnoticed for exactly that reason, and stayed in the
  // store for good. Dropped against the roster rather than on write, and only once the roster is
  // genuinely KNOWN -- `loading` goes false on a stream failure too, and pruning against the empty
  // list that leaves would forget every open card because the sidecar restarted.
  //
  // A Bot's whole reference list, not the sessions that currently resolve: a transcript the sidecar
  // cannot read this minute is still a session the reader left open, and dropping its key would
  // make a temporary absence permanent.
  //
  // An EMPTY roster prunes nothing either, and that guard is the one that was measured rather than
  // reasoned: the stream delivers a snapshot before the Bots are in it, and pruning against that
  // one wiped the store on every mount. A canvas with no Bots has nothing to open, so there is
  // nothing to win by dropping keys there and a whole canvas to lose.
  //
  // `settled` rather than "not loading and not failing", because the roster now comes from several
  // machines: a reader whose remote peer is asleep has a canvas that is entirely healthy about this
  // one, and pruning against it would drop every open card on the peer for good.
  //
  // And `settled` is not enough on its own, because it means every machine IN THE LIST has answered,
  // and a peer leaves the list whenever it misses its heartbeat for 15 seconds -- every restart of
  // its sidecar, every tailnet hiccup. Measured 2026-10-17: the only Bot on the oracle peer came back
  // collapsed, pruned against a roster that held nothing but this Mac's Bots. So each open key is
  // judged only against its own machine (`openMachines`, recorded the first time a Bot is seen
  // holding it), and only while that machine is in the list. A key from before machines were
  // recorded is judged against the whole roster only where no peer can exist; elsewhere it is kept
  // until a Bot is seen holding it, rather than guessed at.
  const [openMachines, setOpenMachines] = useState<ReadonlyMap<string, string>>(loadCanvasOpenMachines);
  const machineKeys = botsState.machineKeys;
  // Joined, so the effects below see a change of machines rather than a new array per render.
  const machineList = botsState.machines === undefined ? undefined : botsState.machines.join("\n");
  /** Each session some Bot holds, and the machine that Bot is on. */
  const holders = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const bot of botsState.bots) {
      const machine = machineKeys?.get(bot.botId) ?? "";
      for (const ref of bot.sessionRefs) byKey.set(`${ref.source}:${ref.sessionId}`, machine);
    }
    return byKey;
  }, [botsState.bots, machineKeys]);
  // A card whose session no Bot holds any more closes, once the Bots have settled. Checked during
  // render against each new set of Bots, and written only when something goes, so a snapshot that
  // changed nothing neither re-renders nor rewrites the store.
  //
  // Compared input by input, never as one memoized object: React Compiler drops a `useMemo` whose
  // result is neither returned nor drawn, so the object was new every render and this looped.
  const pruneOn = [holders, machineList, botsState.settled, botsState.bots] as const;
  const [prunedFor, setPrunedFor] = useState<typeof pruneOn | null>(null);
  if (!prunedFor || pruneOn.some((input, index) => !Object.is(input, prunedFor[index]))) {
    setPrunedFor(pruneOn);
    if (botsState.settled && botsState.bots.length > 0) {
    const present = machineList === undefined ? undefined : new Set(machineList.split("\n"));
    const kept = new Set([...canvasOpenKeys].filter((key) => {
      if (holders.has(key)) return true;
      const machine = openMachines.get(key);
      if (present === undefined) return false;
      return machine === undefined || !present.has(machine);
    }));
    if (kept.size !== canvasOpenKeys.size) setCanvasOpenKeys(kept);
    }
  }
  // Which machine each open card is on, written from one place like the keys themselves: recorded
  // whenever a Bot is seen holding an open key, and dropped once the key is closed.
  const recorded = useMemo(() => ({ canvasOpenKeys, holders }), [canvasOpenKeys, holders]);
  useNotify(recorded, () => {
    const next = new Map<string, string>();
    for (const key of canvasOpenKeys) {
      const machine = holders.get(key) ?? openMachines.get(key);
      if (machine !== undefined) next.set(key, machine);
    }
    const before = openMachines;
    if (next.size === before.size && [...next].every(([key, machine]) => before.get(key) === machine)) return;
    setOpenMachines(next);
    storeCanvasOpenMachines(next);
  });
  /**
   * The order the Bots stand in, left to right, and the one every surface that lists them reads.
   *
   * Up here for the reason the sets above are: the strip is not the only thing that draws this
   * roster. The sidebar's Canvas list is the same Bots, and while this lived inside the canvas that
   * list stayed in the order the machines answered in -- a Bot third on the strip and last in the
   * sidebar, which is two answers to one question.
   *
   * Read off the records' `canvasPosition`, which is what every browser reads. `pendingOrder` is a
   * move the reader just made, held on screen while its writes travel -- one per Bot whose place
   * changed, each to its own machine, so they land one at a time and the strip would otherwise
   * shuffle through every intermediate order. It goes once the records agree, or a write fails.
   */
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const recordOrder = useMemo(() => botCanvasPositionOrder(botsState.bots), [botsState.bots]);
  if (pendingOrder) {
    const landed = botCanvasOrderOf(orderBotsForCanvas(botsState.bots, recordOrder));
    const wanted = botCanvasOrderOf(orderBotsForCanvas(botsState.bots, pendingOrder));
    if (landed.every((id, index) => id === wanted[index])) setPendingOrder(null);
  }
  /** Every Bot the panel can see, arranged. What the sidebar's roster lists. */
  const orderedBots = useMemo(
    () => orderBotsForCanvas(botsState.bots, pendingOrder ?? recordOrder),
    [botsState.bots, pendingOrder, recordOrder],
  );
  // Read through a ref so the move below keeps one identity for the life of the panel: it is handed
  // to the canvas, and a fresh callback on every roster snapshot would rebuild the strip's props.
  const arranged = useLatestRef(orderedBots);
  /**
   * Stands one Bot where another is, naming both rather than their places on the strip.
   *
   * Ids because the strip moves a card among the ones it is SHOWING, and that is a subset twice
   * over: a detached Bot has no card, and a hidden machine's Bots are filtered out of it. An order
   * written from those positions would hold only what was on screen, so a Bot put back would return
   * to the end rather than to its place, and the sidebar -- which lists every one of them -- would
   * disagree with the strip about where it belongs.
   *
   * Writes every Bot whose position is not already its index, which on the first arrangement is all
   * of them, and later is the run between the two ends of the move.
   */
  const moveBot = useCallback((moved: string, target: string) => {
    const ids = botCanvasOrderOf(arranged.current);
    const next = moveInOrder(ids, ids.indexOf(moved), ids.indexOf(target));
    // `moveInOrder` hands back the same array when the move is a no-op, so this is an identity
    // check rather than a comparison of two fresh arrays.
    if (next === ids) return;
    setPendingOrder(next);
    const byId = new Map(arranged.current.map((bot) => [bot.botId, bot]));
    const writes = next
      .map((botId, position) => ({ botId, position }))
      .filter(({ botId, position }) => byId.get(botId)?.canvasPosition !== position)
      .map(({ botId, position }) => setBotCanvas(botId, { position }));
    // A write that failed leaves the records in an order nobody chose, and says so; holding the
    // wanted order over it would hide that until the next reload.
    void Promise.all(writes).then((landed) => {
      if (!landed.every(Boolean)) setPendingOrder(null);
    });
  }, [setBotCanvas, arranged]);
  const canvasBots = orderedBots.filter((bot) => !detachedBotIds.has(bot.botId));
  // Opens one of a Bot's sessions on the canvas rather than in place of it. Puts the Bot back on
  // the canvas first if it was off: the alternative is a click that appears to do nothing, because
  // the card it opens is not being rendered.
  const openSessionOnCanvas = useCallback((bot: BotView, session: SessionSummary) => {
    // The row in the sidebar is the only way back for a session taken off the canvas, so it puts
    // one back for the same reason it puts a detached Bot back: a click that appears to do nothing
    // is worse than a click that does slightly more than asked. One command for both, sent only
    // when something is actually off.
    const sessionOff = (bot.offCanvasSessionRefs ?? []).some((ref) =>
      ref.source === session.source && ref.sessionId === session.sessionId);
    if (bot.offCanvas || sessionOff) {
      void setBotCanvas(bot.botId, {
        ...(bot.offCanvas ? { onCanvas: true } : {}),
        ...(sessionOff
          ? { sessions: [{ source: session.source, sessionId: session.sessionId, onCanvas: true }] }
          : {}),
      });
    }
    // Opens rather than toggles, unlike the card's own row. The same click also puts a detached
    // Bot back, and a click that re-attaches a Bot while closing the session it was clicked for
    // means two contradictory things at once. Closing stays where the card is.
    setCanvasOpenKeys((current) => {
      const key = `${session.source}:${session.sessionId}`;
      if (current.has(key)) return current;
      return new Set(current).add(key);
    });
  }, [setBotCanvas, setCanvasOpenKeys]);

  /**
   * Binds a session one of a Bot's own sessions just made -- `/new` and `/fork` -- to that Bot,
   * and opens its card.
   *
   * A function of the Bot rather than one that takes it per call, because the caller is a card
   * that knows which Bot it belongs to and nothing else does: the session view's context is built
   * once for every session on the surface, so a command run from inside a card has to be handed
   * that card's Bot by the card itself.
   *
   * Here rather than beside the other Bot commands because this is canvas placement, which is
   * what this hook already owns: the attach is what makes the session one of this Bot's, and the
   * open key is the same one `openSessionOnCanvas` writes. A detached Bot goes back on the canvas
   * for the same reason it does there, since a card that is not rendered cannot be opened.
   */
  const attachSessionToBot = useCallback(
    (bot: BotView) => async (session: AgentSessionDescriptor) => {
      try {
        await feeds.forBot(bot.botId).addBotSessions(bot.botId, {
          sessionRefs: [{ source: session.source, sessionId: session.sessionId }],
        });
        if (bot.offCanvas) {
          void setBotCanvas(bot.botId, { onCanvas: true });
        }
        setCanvasOpenKeys((current) => new Set(current).add(`${session.source}:${session.sessionId}`));
      } catch (error) {
        // Named against the Bot rather than a session card: the attach failed, so there is no card
        // for this to land on. The session itself exists either way, which is why the message says
        // so rather than leaving the reader to wonder whether the command ran at all.
        setCanvasError({
          session: null,
          message: `${session.title || session.sessionId} was created but could not be attached to ${bot.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    },
    [feeds, setBotCanvas, setCanvasOpenKeys],
  );
  /**
   * Moves a session no Bot holds onto the canvas: onto the Bot of its directory, which its machine
   * makes first when there is none, and then opens its card.
   *
   * Throws rather than reporting, because the two places it is asked from say a failure in
   * different places: the session's modal sits over the canvas and says it beside the button, the
   * sidebar's row has nothing of its own and uses the canvas band (`moveListedSessionToCanvas`).
   */
  const moveSessionToCanvas = useCallback(async (session: SessionSummary): Promise<void> => {
    const ref = { source: session.source, sessionId: session.sessionId };
    const { bot } = await feeds.forSession(ref).placeSessionOnBot(ref);
    if (bot.offCanvas) void setBotCanvas(bot.botId, { onCanvas: true });
    setCanvasOpenKeys((current) => new Set(current).add(`${ref.source}:${ref.sessionId}`));
  }, [feeds, setBotCanvas, setCanvasOpenKeys]);
  const moveListedSessionToCanvas = useCallback((session: SessionSummary) => {
    setCanvasError(null);
    void moveSessionToCanvas(session).catch((error: unknown) => {
      setCanvasError({
        session: null,
        message: `Could not move ${session.title || session.sessionId} to the canvas: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    });
  }, [moveSessionToCanvas]);
  /**
   * Machines the canvas is not showing, and the chip that changes that.
   *
   * Here rather than inside the canvas for the same reason the open keys are: this is the one
   * place that writes this browser's canvas arrangement, from the setter rather than from a call
   * beside each of the things that change it. Unlike the off-canvas sets it stays in
   * the browser, because it is about which machines this reader wants to see, not about a Bot.
   *
   * Not applied to `canvasBots` below, deliberately. Hiding a machine is a question about what this
   * strip shows, not about which Bots exist -- the sidebar roster still lists every one of them,
   * and `detachedCount` still counts only the Bots a reader actually took off. The canvas does the
   * filtering, beside the chips that say what is hidden.
   */
  const [hiddenMachines, setHiddenMachines] = usePersistentState<ReadonlySet<string>>(loadHiddenMachines, storeHiddenMachines);
  const toggleMachineOnCanvas = useCallback((key: string) => {
    setHiddenMachines((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, [setHiddenMachines]);
  /**
   * Whether the canvas is drawn small enough to see all of at once.
   *
   * Here with the rest of what the reader arranged, and for the same stated reason: the control is
   * in the sidebar's Canvas roster, and a picker cannot drive state that lives inside the thing it
   * is driving. The SCALE is not here -- it belongs to the gesture, nothing above the canvas reads
   * it, and it is kept beside the gesture in `useCanvasZoom`.
   */
  const [canvasZoomMode, setCanvasZoomMode] = usePersistentState<boolean>(loadCanvasZoomMode, storeCanvasZoomMode);
  const toggleCanvasZoom = useCallback(() => setCanvasZoomMode((on) => !on), [setCanvasZoomMode]);
  // How much room the fitted canvas is given to be moved around in, which is the same kind of fact
  // and kept the same way: the control for it sits beside the mode's, in the sidebar.
  const [canvasRoom, setCanvasRoom] = usePersistentState<number>(loadCanvasRoom, storeCanvasRoom);
  const toggleBotOnCanvas = useCallback((bot: BotView) => {
    void setBotCanvas(bot.botId, { onCanvas: Boolean(bot.offCanvas) });
  }, [setBotCanvas]);

  return {
    detachedBotIds,
    detachedSessionKeys,
    canvasError,
    putBotOnCanvas,
    canvasOpenKeys,
    setCanvasOpenKeys,
    orderedBots,
    canvasBots,
    moveBot,
    hiddenMachines,
    toggleMachineOnCanvas,
    canvasZoomMode,
    toggleCanvasZoom,
    canvasRoom,
    setCanvasRoom,
    removeSessionFromCanvas,
    toggleCanvasSession,
    openSessionOnCanvas,
    attachSessionToBot,
    heldSessionKeys,
    moveSessionToCanvas,
    moveListedSessionToCanvas,
    toggleBotOnCanvas,
  };
}
