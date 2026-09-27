// Everything a session needs that is not the session, built once and handed to whichever surface
// is showing one.
//
// Its own file because it was a literal in the middle of the app component, and the app
// component was at the 500-line cap: the object is shell state, exactly like the sidebar props
// beside it, and neither the thread view nor a canvas card is the place to decide how a window
// composer is built or where a tasks panel lands. `SessionViewContext` says what each entry is
// for; this only says where they come from.

import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { HostActionsClient } from "@/features/activity-feed/data-source/HostActionsClient";
import type { WindowComposerClient } from "@/features/window-composer/WindowComposerClient";
import type { EventMode } from "@/features/activity-feed/data-source/AgentDataSource";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SessionViewContext } from "@/features/session-view/sessionTerminalTypes";

export function buildSessionViewContext(input: {
  feed: SidecarDataSource;
  host: HostActionsClient;
  eventMode: EventMode;
  onToggleEventMode: () => void;
  showCacheHits: boolean;
  onToggleCacheHits: () => void;
  windowComposers: { claude: WindowComposerClient; codex: WindowComposerClient };
  /** Whether the tasks panel presents as a sheet rather than a column beside the thread. */
  compact: boolean;
  /** Where the background-tasks panel renders, or null to render it in place. */
  tasksHost: HTMLElement | null;
  /** Branches a Claude session from one of its messages; absent where there is no canvas. */
  onForkFromMessage?: (request: {
    session: SessionSummary;
    projectPath: string;
    message: { eventId: string; text: string };
  }) => void;
}): SessionViewContext {
  return {
    feed: input.feed,
    host: input.host,
    eventMode: input.eventMode,
    onToggleEventMode: input.onToggleEventMode,
    showCacheHits: input.showCacheHits,
    onToggleCacheHits: input.onToggleCacheHits,
    windowComposers: input.windowComposers,
    compact: input.compact,
    tasksHost: input.tasksHost,
    ...(input.onForkFromMessage === undefined ? {} : { onForkFromMessage: input.onForkFromMessage }),
  };
}
