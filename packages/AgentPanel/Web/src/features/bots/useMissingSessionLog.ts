// What the panel actually drew for a Bot's missing session references, said once per transition.
//
// The sidecar logs why a reference went missing (`botSessionResolution.ts`). This is the other half
// of the chain: that the row carrying the word "missing" reached the screen. Without it the two
// ends cannot be joined, because a snapshot the panel never painted -- superseded between the
// socket delivering it and React committing it -- looks in the sidecar's log exactly like one a
// reader watched flash and then go away.
//
// Same edge trigger, one layer over, and for the same reason. A Bot's card re-renders on every
// catalog broadcast, which is every coalesced transcript write, so a level-triggered line here
// writes once per write for as long as the reference stays missing.
//
// The two logs join on `source:sessionId` and the clock. They are deliberately not the same event
// name: one is what the registry decided, the other is what the reader was shown, and a chain is
// only worth having if its links can be told apart.

import { useRef } from "react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import { attachedSessionKey } from "@/features/bots/botRosterOrder";
import { useNotify } from "@/hooks/useNotify";

/**
 * Which surface drew the row.
 *
 * Named because a Bot can be on the canvas and in the sidebar roster at the same time, in which
 * case the reader could be looking at either and the two are separate observations.
 */
export type MissingSessionSurface = "canvas-card" | "roster-row";

/**
 * Says once when a reference starts being drawn as `missing` and once when it stops.
 *
 * `bot` rather than the reference list, because the hook is called from a component that already
 * has the whole Bot and passing half of it invites the two halves to disagree.
 */
export function useMissingSessionLog(bot: BotView, surface: MissingSessionSurface): void {
  const held = useRef<Set<string>>(new Set());
  // Read when the log runs rather than watched. The array is rebuilt on every snapshot, and
  // following its identity would run this on every write even when the missing set is unchanged
  // -- which is the flood the edge trigger exists to prevent. `signature` carries the contents.
  const latest = useRef(bot.missingSessionRefs);
  latest.current = bot.missingSessionRefs;
  const signature = bot.missingSessionRefs.map(attachedSessionKey).sort().join("|");

  // The log is the outside thing told: once per change in which sessions are missing.
  useNotify(`${signature}\n${surface}\n${bot.botId}\n${bot.name}`, () => {
    const missing = latest.current;
    const now = new Set(missing.map(attachedSessionKey));
    for (const key of now) {
      if (held.current.has(key)) continue;
      const ref = missing.find((one) => attachedSessionKey(one) === key);
      console.log(JSON.stringify({
        event: "agent-panel-bot-session-missing",
        surface,
        botId: bot.botId,
        bot: bot.name,
        source: ref?.source ?? null,
        sessionId: ref?.sessionId ?? null,
      }));
    }
    for (const key of held.current) {
      if (now.has(key)) continue;
      console.log(JSON.stringify({
        event: "agent-panel-bot-session-drawn",
        surface,
        botId: bot.botId,
        bot: bot.name,
        session: key,
      }));
    }
    held.current = now;
  });
}
