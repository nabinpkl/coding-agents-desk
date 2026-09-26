// The Father home: the Bot roster's control surface, dropped down from the top of the canvas.
//
// A session card answers "what is this session saying" and pays for it by being one session
// wide: comparing two means scrolling twice and remembering the first. This panel answers the
// other question -- "which sessions are open, and what opens next" -- with every Bot's roster
// as pills in one scroll, while the strip below keeps showing the open ones. Both stay visible
// at once, and the grip at its bottom is where they fight for vertical room: dragging it down
// grows this panel and squeezes the strip, dragging it up gives the room back.
//
// Pills rather than a second roster of rows, because the sidebar's Canvas tab already IS that
// roster. A second copy of it here would be a second place to look for a Bot and a second thing
// to keep in step; a pill is an open/close switch and nothing else, which is the only act this
// surface adds.

import { Crown, Plus, X } from "lucide-react";
import { useState } from "react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import { BotAvatar } from "@/features/bots/avatar/BotAvatar";
import { botsOnShownMachines } from "@/features/bots/botMachines";
import { sessionKey } from "@/features/bots/cards/botCanvasCards";
import { useCardResize } from "@/features/bots/cards/useCardResize";
import {
  DEFAULT_CARD_WIDTH,
  clampFatherHeight,
  loadFatherHeight,
  storeFatherHeight,
} from "@/features/bots/canvas/botCanvasPreferences";
import { ActivityDot } from "@/features/sidebar/SessionMeta";

export function FatherButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  if (open) return null;
  // Floating rather than a row of canvas chrome, because the canvas spends no rows on chrome:
  // every row it spends is a row its cards do not get, which is why its status lives in the
  // sidebar. A button that floats costs no rows; the open panel does, and says so by pushing
  // the strip down rather than covering it.
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={false}
      aria-expanded={false}
      aria-controls="father-home"
      title="Open the Father home: every Bot's sessions as open/close switches"
      className="absolute top-3 right-3 z-30 flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-full border border-border bg-card/95 px-4 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold text-foreground shadow-lg backdrop-blur outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
    >
      <Crown className="size-4 shrink-0 text-primary" aria-hidden />
      Father
    </button>
  );
}

export function FatherOverlay({
  bots,
  hues,
  ranks,
  machines,
  keyOfBot,
  hiddenMachines,
  detachedSessionKeys,
  openKeys,
  onToggleSession,
  onAddBot,
  onClose,
}: {
  bots: BotView[];
  hues: ReadonlyMap<string, number>;
  ranks: ReadonlyMap<string, number>;
  machines: readonly { key: string; label: string }[];
  keyOfBot: (botId: string) => string | undefined;
  hiddenMachines: ReadonlySet<string>;
  detachedSessionKeys: ReadonlySet<string>;
  openKeys: ReadonlySet<string>;
  onToggleSession: (key: string) => void;
  onAddBot: () => void;
  onClose: () => void;
}) {
  // Owned here rather than in the canvas, so a drag writes storage only on release: the strip
  // below follows the live value, and the stored one is the answer the reader settled on.
  const [height, setHeight] = useState(loadFatherHeight);
  // Hidden machines drop out here the same way they do in the strip, so the switches below and
  // the cards underneath never disagree about which Bots are on screen.
  const standing = botsOnShownMachines(bots, hiddenMachines, keyOfBot);
  const labelOf = (botId: string): string | undefined => {
    const key = keyOfBot(botId);
    return key === undefined ? undefined : machines.find((machine) => machine.key === key)?.label;
  };
  const shownSessionsOf = (bot: BotView) =>
    bot.sessions.filter((session) => !detachedSessionKeys.has(sessionKey(session)));
  const openCount = standing.flatMap(shownSessionsOf)
    .filter((session) => openKeys.has(sessionKey(session))).length;
  const resize = useCardResize({
    name: "Father home",
    noun: "card",
    size: { width: DEFAULT_CARD_WIDTH, height },
    canResizeWidth: false,
    canResizeHeight: true,
    onResize: (next) => setHeight(clampFatherHeight(next.height)),
    onResizeCommit: (next) => {
      const clamped = clampFatherHeight(next.height);
      setHeight(clamped);
      storeFatherHeight(clamped);
    },
  });

  return (
    <section
      id="father-home"
      aria-label="Father home"
      style={{ height: resize.height }}
      className="flex shrink-0 flex-col border-b border-border bg-card"
    >
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2">
        <Crown className="size-4 shrink-0 text-primary" aria-hidden />
        <h2 className="shrink-0 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold text-foreground">
          Father
        </h2>
        <p role="status" className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          {standing.length === bots.length
            ? `${bots.length} ${bots.length === 1 ? "bot" : "bots"}`
            : `${standing.length} of ${bots.length} bots`}
          {` · ${openCount} open`}
        </p>
        <button
          type="button"
          onClick={onAddBot}
          aria-label="Add a Bot"
          title="Add a Bot"
          className="flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
        >
          <Plus className="size-4" aria-hidden />
          Add Bot
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the Father home"
          title="Close the Father home"
          className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-1">
        {standing.length === 0 ? (
          <p className="py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            Every machine is hidden, so there is no roster to switch. Show a machine from the
            sidebar&apos;s Canvas tab to bring its Bots back.
          </p>
        ) : (
          <ul role="list" aria-label="Bots and their sessions">
            {standing.map((bot) => {
              const shown = shownSessionsOf(bot);
              const machineLabel = labelOf(bot.botId);
              return (
                <li key={bot.botId} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
                  <BotAvatar bot={bot} hue={hues.get(bot.botId)} rank={ranks.get(bot.botId)} size="size-7" />
                  <span className="max-w-40 shrink-0 truncate text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground">
                    {bot.name}
                  </span>
                  {machineLabel ? (
                    <span className="shrink-0 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
                      {machineLabel}
                    </span>
                  ) : null}
                  {shown.length === 0 ? (
                    <span className="text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
                      {bot.sessions.length > 0 ? "sessions off the canvas" : "no sessions"}
                    </span>
                  ) : (
                    shown.map((session) => {
                      const key = sessionKey(session);
                      const on = openKeys.has(key);
                      const label = session.title || `${session.sessionId.slice(0, 8)}…`;
                      return (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={on}
                          title={on
                            ? `Close ${label} on the canvas`
                            : `Open ${label} on the canvas`}
                          onClick={() => onToggleSession(key)}
                          className={`flex min-h-7 max-w-48 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
                            on
                              ? "border-primary bg-primary/10 text-foreground hover:bg-primary/15 active:bg-primary/20"
                              : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80"
                          }`}
                        >
                          {session.activity === "live" ? <ActivityDot activity="live" /> : null}
                          <span className="truncate">{label}</span>
                        </button>
                      );
                    })
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {resize.bottom}
    </section>
  );
}
