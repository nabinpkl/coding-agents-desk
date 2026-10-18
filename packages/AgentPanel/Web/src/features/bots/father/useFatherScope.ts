// The Father home's own pipeline: bot records in, a session context out.
//
// No canvas, no arrangement. The canvas roster answers which Bots stand where; this answers which
// session the home shows, by reading the records' own `fatherSession` straight off the machines'
// bot streams (`useBots`) and resolving it against the record's own sessions. Taking a Bot off
// the canvas, hiding a machine, or never opening the canvas at all changes nothing here -- the
// home is a site manager, not a card.
//
// The read half stays live the way a session subscriber does: the bot streams push, so a Father
// named, cleared, or forgotten on any machine reaches the home without a reload.

import { useCallback, useMemo, useState } from "react";
import type {
  AgentSessionDescriptor,
  BotSessionRef,
  BotView,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { HostActionsClient } from "@/features/activity-feed/data-source/HostActionsClient";
import { useBots } from "@/features/bots/useBots";
import type { BotMachine } from "@/features/bots/botMachines";
import { sidecarWindowComposerClient } from "@/features/window-composer/WindowComposerClient";
import {
  loadEventMode,
  storeEventMode,
} from "@/features/activity-feed/reading-preferences/eventModeStore";
import {
  loadCacheHitsVisible,
  storeCacheHitsVisible,
} from "@/features/activity-feed/reading-preferences/cacheHitStore";
import { useSidebarEnvironment } from "@/features/sidebar/SidebarPresentation";
import type { SessionViewContext } from "@/features/session-view/SessionView";
import type { BotCommandError } from "@/features/bots/canvas/BotCanvas";
import { sessionKey } from "@/features/bots/cards/botCanvasCards";

/** A window-composer pair per sidecar, made the first time each is asked for. */
function composerPairs() {
  const pairs = new Map<
    SidecarDataSource,
    { claude: ReturnType<typeof sidecarWindowComposerClient>; codex: ReturnType<typeof sidecarWindowComposerClient> }
  >();
  return (feedFor: SidecarDataSource) => {
    const hit = pairs.get(feedFor);
    if (hit) return hit;
    const pair = {
      claude: sidecarWindowComposerClient(feedFor, "claude"),
      codex: sidecarWindowComposerClient(feedFor, "codex"),
    };
    pairs.set(feedFor, pair);
    return pair;
  };
}

export function useFatherScope({
  feed,
  host,
  machines,
}: {
  /** The panel's own sidecar: the default every answer below falls back to. */
  feed: SidecarDataSource;
  host: HostActionsClient;
  /** Every sidecar the home reads records from, home first. */
  machines: readonly BotMachine[];
}) {
  const roster = useBots(machines);
  // A failure from editing the Father's Bot, shown when it is about the Father session. Cleared
  // as the next edit starts: it belongs to the edit, so it outlives a send and not another edit.
  const [botError, setBotError] = useState<BotCommandError | null>(null);
  // The reader's own preferences, read here rather than handed down: nothing above the home owns
  // them, and the home must stand where no shell set them.
  const [eventMode, setEventMode] = useState(loadEventMode);
  const [showCacheHits, setShowCacheHits] = useState(loadCacheHitsVisible);
  const toggleEventMode = useCallback(() => {
    setEventMode((mode) => {
      const next = mode === "nice" ? "raw" : "nice";
      storeEventMode(next);
      return next;
    });
  }, []);
  const toggleCacheHits = useCallback(() => {
    setShowCacheHits((visible) => {
      storeCacheHitsVisible(!visible);
      return !visible;
    });
  }, []);
  const { compact } = useSidebarEnvironment();
  // Where the session's background-tasks panel lands: a node of the home's own, the way a card
  // gives it, or two open surfaces would land both in the app's single host.
  const [tasksHost, setTasksHost] = useState<HTMLElement | null>(null);
  // One window-composer pair per sidecar, because typing into another application's text field
  // is something a sidecar does on the machine it runs on. Keyed on the feed object, which is
  // stable per machine, so a roster push does not rebuild the clients out from under the session.
  // Rebuilt when the machines change, so a machine that left takes its clients with it.
  const composersFor = useMemo(() => composerPairs(), [feed, machines]);

  /**
   * The context the Father's session renders in, by Bot.
   *
   * A resolver rather than a context because the Father's directory is not necessarily on this
   * machine: its transcripts, commands and terminals go through its own machine's sidecar. The
   * shape is `SessionViewContext`, the same contract a card is handed, so the home renders the
   * session itself rather than a lesser copy of it. Fork-from-message is absent: that act opens
   * a canvas card, which a site manager has no business doing.
   */
  const sessionContextFor = useCallback(
    (botId: string): SessionViewContext => {
      // The index rather than `machineOf`: this is asked while the home renders.
      const feedFor = roster.machineIndex.bot.get(botId)?.feed ?? feed;
      return {
        feed: feedFor,
        host,
        eventMode,
        onToggleEventMode: toggleEventMode,
        showCacheHits,
        onToggleCacheHits: toggleCacheHits,
        windowComposers: composersFor(feedFor),
        compact,
        tasksHost,
      };
    },
    [roster, feed, host, eventMode, toggleEventMode, showCacheHits, toggleCacheHits, composersFor, compact, tasksHost],
  );

  /**
   * Binds a session the Father's Bot just made to that Bot.
   *
   * Binding only, unlike the canvas's version: there is no card to open and no strip to put the
   * Bot back on. The stream carries the new record back, so nothing here is updated on success.
   */
  const attachSessionToBot = useCallback(
    (bot: BotView) => async (session: AgentSessionDescriptor) => {
      const feedFor = roster.machineOf(bot.botId)?.feed ?? feed;
      try {
        await feedFor.addBotSessions(bot.botId, {
          sessionRefs: [{ source: session.source, sessionId: session.sessionId }],
        });
        setBotError(null);
      } catch (error) {
        setBotError({
          session: null,
          message: `${session.title || session.sessionId} was created but could not be attached to ${bot.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    },
    [roster, feed],
  );

  /**
   * Drops the Father reference from its Bot's projection. The session itself is untouched.
   *
   * Rebuilt field by field rather than forwarded: a summary structurally satisfies a ref, and
   * passing it straight on would put capabilities, titles and timestamps on the wire.
   */
  const onDetachSession = useCallback(
    (bot: BotView, ref: BotSessionRef) => {
      const label = bot.sessions
        .find((session) => session.source === ref.source && session.sessionId === ref.sessionId)
        ?.title || ref.sessionId;
      const target: BotSessionRef = { source: ref.source, sessionId: ref.sessionId };
      setBotError(null);
      const feedFor = roster.machineOf(bot.botId)?.feed ?? feed;
      void Promise.resolve()
        .then(() => feedFor.detachBotSessions(bot.botId, { sessionRefs: [target] }))
        .catch((error: unknown) => {
          setBotError({
            session: sessionKey(target),
            message: `Could not remove ${label} from ${bot.name}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        });
    },
    [roster, feed],
  );

  return {
    /** Every Bot the panel can see, records only: no canvas order, no off-canvas sets. */
    bots: roster.bots,
    /** Nothing has arrived and nothing has failed: the home has no answer yet, good or bad. */
    loading: roster.loading,
    sessionContextFor,
    attachSessionToBot,
    onDetachSession,
    botError,
    setTasksHost,
  };
}
