// What the reader arranged on the canvas: which Bots are on it, which sessions are open, and which
// machines it is showing at all.
//
// Four sets, all remembered, and all held above the canvas rather than inside it -- the sidebar's
// roster puts a Bot back and opens a card too, and a picker cannot drive state that lives inside
// the thing it is driving. `botCanvasPreferences` carries why remembering them is safe now and
// was not before.

import { useCallback, useEffect, useState } from "react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import {
  loadCanvasOpenKeys,
  loadDetachedBotIds,
  loadDetachedSessionKeys,
  loadHiddenMachines,
  storeCanvasOpenKeys,
  storeDetachedBotIds,
  storeDetachedSessionKeys,
  storeHiddenMachines,
} from "@/features/bots/botCanvasPreferences";
import { loadCanvasZoomMode, storeCanvasZoomMode } from "@/features/bots/useCanvasZoom";

export function useCanvasRoster(botsState: {
  bots: BotView[];
  /** Every machine's roster has arrived. See the prune below for why "not failing" is not enough. */
  settled: boolean;
}) {
  // What the reader has taken off the canvas: whole Bots by id, then single sessions as
  // `source:sessionId`. Both live here rather than inside the canvas so the cards and the sidebar
  // roster that arranges them read one set each, and both are remembered across reloads --
  // `botCanvasPreferences` carries why that is safe now and was not before.
  const [detachedBotIds, setDetachedBotIds] = useState<ReadonlySet<string>>(loadDetachedBotIds);
  const [detachedSessionKeys, setDetachedSessionKeys] = useState<ReadonlySet<string>>(
    loadDetachedSessionKeys,
  );
  const removeSessionFromCanvas = useCallback((session: BotSessionRef) => {
    setDetachedSessionKeys((current) => new Set(current).add(`${session.source}:${session.sessionId}`));
  }, []);
  // Which sessions the canvas has open, as `source:sessionId`. Held here rather than inside the
  // canvas because the sidebar's roster opens cards too, and a picker cannot drive state that lives
  // inside the thing it is driving.
  const [canvasOpenKeys, setCanvasOpenKeys] = useState<ReadonlySet<string>>(loadCanvasOpenKeys);
  const toggleCanvasSession = useCallback((key: string) => {
    setCanvasOpenKeys((current) => {
      // A new set rather than a mutation, because React decides whether to re-render by identity.
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  // One write for every way the open cards change -- a row's own toggle, the sidebar roster opening
  // one, a Bot leaving the canvas -- rather than a call beside each of them, which is how one of
  // them ends up forgotten.
  useEffect(() => storeCanvasOpenKeys(canvasOpenKeys), [canvasOpenKeys]);
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
  useEffect(() => {
    if (!botsState.settled || botsState.bots.length === 0) return;
    const held = new Set(
      botsState.bots.flatMap((bot) => bot.sessionRefs.map((ref) => `${ref.source}:${ref.sessionId}`)),
    );
    setCanvasOpenKeys((current) => {
      const kept = new Set([...current].filter((key) => held.has(key)));
      // Identity when nothing goes, so this neither re-renders nor rewrites the store on every
      // snapshot the stream sends.
      return kept.size === current.size ? current : kept;
    });
  }, [botsState.bots, botsState.settled]);
  // The same one-write rule, and these two need it more than the open keys do: each set shrinks
  // from the sidebar roster and from a real detach as well as growing from a menu, so a call beside
  // each of those is how one of them ends up forgotten.
  useEffect(() => storeDetachedBotIds(detachedBotIds), [detachedBotIds]);
  useEffect(() => storeDetachedSessionKeys(detachedSessionKeys), [detachedSessionKeys]);
  const canvasBots = botsState.bots.filter((bot) => !detachedBotIds.has(bot.botId));
  // Opens one of a Bot's sessions on the canvas rather than in place of it. Puts the Bot back on
  // the canvas first if it was off: the alternative is a click that appears to do nothing, because
  // the card it opens is not being rendered.
  const openSessionOnCanvas = useCallback((bot: BotView, session: SessionSummary) => {
    // The row in the sidebar is the only way back for a session taken off the canvas, so it puts
    // one back for the same reason it puts a detached Bot back: a click that appears to do nothing
    // is worse than a click that does slightly more than asked.
    setDetachedSessionKeys((current) => {
      const key = `${session.source}:${session.sessionId}`;
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setDetachedBotIds((current) => {
      if (!current.has(bot.botId)) return current;
      const next = new Set(current);
      next.delete(bot.botId);
      return next;
    });
    // Opens rather than toggles, unlike the card's own row. The same click also puts a detached
    // Bot back, and a click that re-attaches a Bot while closing the session it was clicked for
    // means two contradictory things at once. Closing stays where the card is.
    setCanvasOpenKeys((current) => {
      const key = `${session.source}:${session.sessionId}`;
      if (current.has(key)) return current;
      return new Set(current).add(key);
    });
  }, []);
  /**
   * Machines the canvas is not showing, and the chip that changes that.
   *
   * Here rather than inside the canvas for the same reason the other three sets are: this is the
   * one place that writes the reader's canvas arrangement, from one effect on the value rather than
   * from a call beside each of the things that change it.
   *
   * Not applied to `canvasBots` below, deliberately. Hiding a machine is a question about what this
   * strip shows, not about which Bots exist -- the sidebar roster still lists every one of them,
   * and `detachedCount` still counts only the Bots a reader actually took off. The canvas does the
   * filtering, beside the chips that say what is hidden.
   */
  const [hiddenMachines, setHiddenMachines] = useState<ReadonlySet<string>>(loadHiddenMachines);
  const toggleMachineOnCanvas = useCallback((key: string) => {
    setHiddenMachines((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  useEffect(() => storeHiddenMachines(hiddenMachines), [hiddenMachines]);
  /**
   * Whether the canvas is drawn small enough to see all of at once.
   *
   * Here with the rest of what the reader arranged, and for the same stated reason: the control is
   * in the sidebar's Canvas roster, and a picker cannot drive state that lives inside the thing it
   * is driving. The SCALE is not here -- it belongs to the gesture, nothing above the canvas reads
   * it, and it is kept beside the gesture in `useCanvasZoom`.
   */
  const [canvasZoomMode, setCanvasZoomMode] = useState<boolean>(loadCanvasZoomMode);
  const toggleCanvasZoom = useCallback(() => setCanvasZoomMode((on) => !on), []);
  useEffect(() => storeCanvasZoomMode(canvasZoomMode), [canvasZoomMode]);
  const toggleBotOnCanvas = useCallback((bot: BotView) => {
    setDetachedBotIds((current) => {
      // A new set rather than a mutation, because React decides whether to re-render by identity.
      const next = new Set(current);
      if (!next.delete(bot.botId)) next.add(bot.botId);
      return next;
    });
  }, []);

  return {
    detachedBotIds,
    setDetachedBotIds,
    detachedSessionKeys,
    setDetachedSessionKeys,
    canvasOpenKeys,
    setCanvasOpenKeys,
    canvasBots,
    hiddenMachines,
    toggleMachineOnCanvas,
    canvasZoomMode,
    toggleCanvasZoom,
    removeSessionFromCanvas,
    toggleCanvasSession,
    openSessionOnCanvas,
    toggleBotOnCanvas,
  };
}
