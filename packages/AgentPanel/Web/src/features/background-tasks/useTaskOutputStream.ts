import type { BackgroundTaskProgress, BackgroundTaskState } from "@agentdesk/agent-feed-wire";
import type { AgentDataSource, SessionReference } from "@/features/activity-feed/data-source/AgentDataSource";
import { useStateFor } from "@/hooks/state/useStateFor";
import { useSubscription } from "@/hooks/useSubscription";
import { sourceKey } from "@/query/panelQuery";

export interface TaskOutputView {
  label: string;
  text: string;
  progress: BackgroundTaskProgress | null;
  /** Set once the task ends while being watched, so the row settles without another poll. */
  ended: BackgroundTaskState | null;
  unavailable: string | null;
}

const INITIAL: TaskOutputView = {
  label: "",
  text: "",
  progress: null,
  ended: null,
  unavailable: null,
};

/**
 * How much output the panel keeps in the DOM.
 *
 * A build log runs to hundreds of thousands of lines and none of them past the last few hundred
 * are what someone watching a running task is looking at. The server already caps the opening
 * snapshot; this caps what accumulates afterwards.
 */
const MAX_LINES = 500;

function appendBounded(existing: string, addition: string): string {
  if (!addition) return existing;
  const combined = existing ? `${existing}${addition}` : addition;
  const lines = combined.split("\n");
  if (lines.length <= MAX_LINES) return combined;
  return lines.slice(lines.length - MAX_LINES).join("\n");
}

/**
 * One task's live output, opened on demand.
 *
 * Subscribing is the whole cost model: nothing streams until a row is expanded, and the stream
 * closes when it collapses. Several tasks in flight do not become several open streams unless the
 * viewer deliberately opens them.
 */
export function useTaskOutputStream(
  source: AgentDataSource,
  session: SessionReference | null,
  taskId: string | null,
): TaskOutputView {
  const sessionId = session?.sessionId ?? null;
  const key = session && taskId ? `${sourceKey(source)}:${session.source}:${sessionId}:${taskId}` : null;
  const [view, setView] = useStateFor<TaskOutputView>(key, () => INITIAL);

  useSubscription(key, () => {
    if (!session || !taskId) return;
    return source.subscribeTaskOutput(session, taskId, {
      onMessage: (message) => {
        setView((current) => {
          switch (message.kind) {
            case "snapshot":
              return {
                label: message.label,
                text: message.text,
                progress: message.progress,
                ended: null,
                unavailable: null,
              };
            case "append":
              return {
                ...current,
                text: appendBounded(current.text, message.text),
                progress: message.progress,
              };
            case "ended":
              return { ...current, ended: message.state };
            case "unavailable":
              return { ...current, unavailable: message.reason };
          }
        });
      },
      onError: (reason) => setView((current) => ({ ...current, unavailable: reason })),
    });
  });

  return view;
}
