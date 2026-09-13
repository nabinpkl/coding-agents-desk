import type { AgentDataSource } from "@/features/activity-feed/data-source/AgentDataSource";

/**
 * An `AgentDataSource` that answers nothing, for tests about something else.
 *
 * Exists so that adding a capability to the interface is one edit rather than one edit per test
 * file. Before it, seven inline doubles each restated the whole shape, which meant every new
 * method broke seven unrelated suites and tempted the interface into optionality to avoid it.
 *
 * Override only what a test actually exercises; anything unset is inert rather than absent, so a
 * component that reaches for an unrelated capability gets a no-op instead of a crash.
 */
export function stubDataSource(overrides: Partial<AgentDataSource> = {}): AgentDataSource {
  return {
    fetchEventsPage: async () => ({ events: [], total: 0, usage: null }),
    subscribeSessionEvents: () => () => {},
    fetchRawEvent: async () => "",
    subscribeBackgroundTasks: () => () => {},
    subscribeTaskOutput: () => () => {},
    subscribeSubagentTranscript: () => () => {},
    lastMessage: async () => {
      throw new Error("no message");
    },
    ...overrides,
  };
}
