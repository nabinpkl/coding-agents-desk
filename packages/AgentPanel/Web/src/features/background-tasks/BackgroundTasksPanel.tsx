import { useEffect, useRef, useState } from "react";
import type {
  BackgroundTask,
  BackgroundTaskSnapshot,
  BackgroundTaskState,
  RunningBackgroundTask,
} from "@agentdesk/agent-feed-wire";
import type { AgentDataSource, SessionReference } from "../activity-feed/data-source/AgentDataSource";
import { useElapsedNow } from "./useBackgroundTasks";
import { useTaskOutputStream } from "./useTaskOutputStream";

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1_000_000) return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1000) return `${(bytesPerSecond / 1000).toFixed(1)} kB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

function describeState(state: BackgroundTaskState): string {
  switch (state.status) {
    case "running":
      return "running";
    case "killed":
      return "killed";
    case "exited":
      return state.exitCode === null ? "failed" : `exit ${state.exitCode}`;
    case "unknown":
      // Honest rather than tidy. This is a task whose output file was reaped and whose completion
      // was never recorded, which is over -- but we did not see how.
      return "ended, outcome unknown";
  }
}

/**
 * A task's live output.
 *
 * `label` names the file, which is worth showing because it is frequently NOT the task's own
 * capture: a command that redirects into a log is streamed from that log, and saying so is how the
 * viewer knows why the output looks the way it does.
 */
function TaskOutput({
  source,
  session,
  taskId,
}: {
  source: AgentDataSource;
  session: SessionReference;
  taskId: string;
}) {
  const view = useTaskOutputStream(source, session, taskId);
  const scroller = useRef<HTMLPreElement | null>(null);
  const pinned = useRef(true);

  // Follow the tail, but stop following the moment the viewer scrolls up. Someone reading an
  // error forty lines back should not be yanked to the bottom two seconds later.
  useEffect(() => {
    const node = scroller.current;
    if (!node || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
  }, [view.text]);

  if (view.unavailable) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{view.unavailable}</p>;
  }

  return (
    <div className="border-t border-border">
      <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-muted-foreground">
        <span className="truncate font-mono">{view.label || "…"}</span>
        {view.progress ? (
          <span className="ml-auto shrink-0 tabular-nums">
            {formatRate(view.progress.bytesPerSecond)} · idle {formatDuration(view.progress.idleMs)}
          </span>
        ) : null}
      </div>
      <pre
        ref={scroller}
        data-testid="task-output"
        onScroll={(event) => {
          const node = event.currentTarget;
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        }}
        className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-background px-3 py-2 font-mono text-[11px] leading-snug text-foreground"
      >
        {view.text || "waiting for output…"}
      </pre>
      {view.ended ? (
        <p className="px-3 py-1 text-[11px] text-muted-foreground">
          finished — {describeState(view.ended)}
        </p>
      ) : null}
    </div>
  );
}

function RunningRow({
  task,
  now,
  expanded,
  onToggle,
  source,
  session,
}: {
  task: RunningBackgroundTask;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  source: AgentDataSource;
  session: SessionReference;
}) {
  // Prefer the clock the client keeps over the one that shipped, so the number moves between
  // server messages instead of freezing for as long as nothing else changed.
  const elapsed = task.startedAt === null ? task.elapsedMs : Math.max(0, now - task.startedAt);
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid={`task-row-${task.taskId}`}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted"
      >
        <span className="mt-1 inline-flex size-1.5 shrink-0 rounded-full bg-amber-500" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-foreground">{task.description}</span>
          <span className="block text-[11px] text-muted-foreground tabular-nums">
            {formatDuration(elapsed)}
            {task.hasOutput ? "" : " · output redirected"}
          </span>
        </span>
      </button>
      {expanded ? <TaskOutput source={source} session={session} taskId={task.taskId} /> : null}
    </li>
  );
}

function FinishedRow({ task }: { task: BackgroundTask }) {
  return (
    <li className="flex items-start gap-2 px-3 py-1.5">
      <span className="mt-1.5 inline-flex size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-muted-foreground">{task.description}</span>
        <span className="block text-[11px] text-muted-foreground/70">{describeState(task.state)}</span>
      </span>
    </li>
  );
}

export function BackgroundTasksContent({
  snapshot,
  source,
  session,
  onClose,
}: {
  snapshot: BackgroundTaskSnapshot;
  source: AgentDataSource;
  session: SessionReference;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  // Only tick while something is running. An open panel over a settled session should not keep a
  // timer alive, on a phone least of all.
  const now = useElapsedNow(snapshot.running.length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <h2 className="min-w-0 flex-1 truncate px-1 text-[13px] font-semibold text-foreground">
          Background tasks
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close background tasks"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ✕
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {snapshot.running.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-muted-foreground">
            {snapshot.ownerAlive
              ? "Nothing running."
              : "No live process is serving this session, so nothing can be running."}
          </p>
        ) : (
          <ul>
            {snapshot.running.map((task) => (
              <RunningRow
                key={task.taskId}
                task={task}
                now={now}
                expanded={expanded === task.taskId}
                onToggle={() => setExpanded((current) => (current === task.taskId ? null : task.taskId))}
                source={source}
                session={session}
              />
            ))}
          </ul>
        )}
        {snapshot.finished.length > 0 ? (
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => setShowFinished((current) => !current)}
              aria-expanded={showFinished}
              data-testid="finished-tasks-toggle"
              className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-muted"
            >
              Finished {snapshot.finished.length}
            </button>
            {showFinished ? <ul>{snapshot.finished.map((task) => <FinishedRow key={task.taskId} task={task} />)}</ul> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The panel, in the two presentations this shell already distinguishes.
 *
 * On the Mac it is a column beside the thread, mirroring where the projects sidebar sits on the
 * other side. On a phone it is a bottom sheet, because the control that opens it is a chip at the
 * bottom of the screen and a panel that flies in from an edge the finger never touched reads as
 * unrelated to the thing that was tapped. The responsive switch is the shell's own, not a second
 * rule invented here.
 */
export function BackgroundTasksPanel({
  compact,
  snapshot,
  source,
  session,
  onClose,
}: {
  compact: boolean;
  snapshot: BackgroundTaskSnapshot;
  source: AgentDataSource;
  session: SessionReference;
  onClose: () => void;
}) {
  if (compact) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col justify-end" data-testid="tasks-sheet">
        <button
          type="button"
          aria-label="Close background tasks"
          onClick={onClose}
          className="absolute inset-0 bg-black/40"
        />
        <div className="relative max-h-[70dvh] min-h-0 overflow-hidden rounded-t-2xl border-t border-border bg-card pb-[env(safe-area-inset-bottom)] shadow-2xl">
          <BackgroundTasksContent
            snapshot={snapshot}
            source={source}
            session={session}
            onClose={onClose}
          />
        </div>
      </div>
    );
  }
  return (
    <aside
      data-testid="tasks-column"
      className="flex w-80 shrink-0 flex-col border-l border-border bg-card"
    >
      <BackgroundTasksContent
        snapshot={snapshot}
        source={source}
        session={session}
        onClose={onClose}
      />
    </aside>
  );
}
