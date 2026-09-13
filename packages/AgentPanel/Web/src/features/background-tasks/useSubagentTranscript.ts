import { useEffect, useState } from "react";
import type { SubagentForkOrigin } from "@agentdesk/agent-feed-wire";
import type {
  AgentDataSource,
  SessionReference,
} from "@/features/activity-feed/data-source/AgentDataSource";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

export interface SubagentTranscriptView {
  events: ActivityEvent[];
  /** Null until the opening snapshot lands, which is what separates "loading" from "empty". */
  loaded: boolean;
  forkOrigin: SubagentForkOrigin | null;
  unavailable: string | null;
}

const INITIAL: SubagentTranscriptView = {
  events: [],
  loaded: false,
  forkOrigin: null,
  unavailable: null,
};

/**
 * One subagent's transcript, opened on demand.
 *
 * Same cost model as task output: nothing streams until a row is expanded, and the stream closes
 * when it collapses. Three runs in flight are three rows and no open streams until someone looks.
 *
 * The list only ever grows. Appends are appended and nothing replaces what is already held --
 * there is deliberately no snapshot-replaces-state path here, because that is precisely the bug
 * this panel's sibling stream had to be taught out of. A subagent transcript is append-only on
 * disk and its indices never renumber, so a later snapshot could only ever say the same thing
 * again.
 */
export function useSubagentTranscript(
  source: AgentDataSource,
  session: SessionReference | null,
  agentId: string | null,
): SubagentTranscriptView {
  const [view, setView] = useState<SubagentTranscriptView>(INITIAL);
  const sessionId = session?.sessionId ?? null;

  useEffect(() => {
    if (!session || !agentId) {
      setView(INITIAL);
      return;
    }
    setView(INITIAL);
    return source.subscribeSubagentTranscript(session, agentId, {
      onMessage: (message) => {
        setView((current) => {
          switch (message.kind) {
            case "snapshot":
              return {
                events: message.events,
                loaded: true,
                forkOrigin: message.forkOrigin ?? null,
                unavailable: null,
              };
            case "append": {
              // Guarded by index rather than trusted: a reconnect replays the snapshot, and
              // without this the run would show every event twice.
              if (current.events.some((event) => event.index === message.event.index)) {
                return current;
              }
              return { ...current, events: [...current.events, message.event] };
            }
            case "unavailable":
              return { ...current, loaded: true, unavailable: message.reason };
          }
        });
      },
      onError: (reason) => setView((current) => ({ ...current, unavailable: reason })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, sessionId, agentId]);

  return view;
}
