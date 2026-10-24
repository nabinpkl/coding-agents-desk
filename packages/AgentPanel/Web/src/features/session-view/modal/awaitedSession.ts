// A session that is running before the catalog lists it, as a summary the session view can take.
//
// A Claude session writes no transcript until its first turn, so for that moment nothing the panel
// reads from knows it exists. The arena's contestants and a session started through the Agent SDK
// both open their view in that gap, with `listed={false}` so the feed does not ask for a transcript
// that is not there yet.

import type { SessionSummary } from "@agentdesk/agent-feed-wire";

/**
 * Claims nothing the sidecar has not said -- no sends, no terminal beyond the pane, one mode -- and
 * the listed summary replaces it the moment there is one.
 */
export function awaitedSession(
  source: SessionSummary["source"],
  sessionId: string,
  title: string,
  at: number | null,
): SessionSummary {
  return {
    sessionId,
    source,
    title,
    lastEventAt: at ?? 0,
    activity: "ready",
    capabilities: {
      modes: ["nice"],
      canSend: false,
      canSteer: false,
      canAbort: false,
      canFetchRaw: false,
      canOpenTerminal: false,
      supportsExtensionUi: false,
      canStreamLive: false,
    },
  };
}
