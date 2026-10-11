// The arena tab: one prompt fanned out to contestants, read side by side.
//
// A comparison console rather than a list of tasks. The rail down the left holds the runs and the
// way into a new one; the main column holds whichever of the two the reader is on -- the composer,
// or a run laid out for comparison (its facts in one table, then its contestants' sessions, files
// or diffs in parallel lanes). Below a comfortable width the rail stacks above the column instead
// of squeezing it, because the lanes need the width more than the list does.
//
// The arena judges nothing. Every view puts the same fact for each contestant on one line and
// leaves the reading to the reader, and a contestant's session is the ordinary catalog session
// rendered by the ordinary `SessionView` -- the tab adds the grouping, the alignment and the
// facts, never a second transcript reader.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createArenaRun,
  deleteArenaRun,
  fetchArenaRunDetail,
  fetchArenaRuns,
  parseRunsStreamFrame,
  STREAM_PATH,
} from "@/features/arena/arenaRunsSource";
import type { ArenaRunDetail, ArenaRunSummary } from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import type { EventMode } from "@/features/activity-feed/data-source/AgentDataSource";
import type { HostActionsClient } from "@/features/activity-feed/data-source/HostActionsClient";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { SessionViewContext } from "@/features/session-view/SessionView";
import { sidecarWindowComposerClient } from "@/features/window-composer/WindowComposerClient";
import { ArenaNewRun, EMPTY_DRAFT, type ArenaDraft } from "@/features/arena/ArenaNewRun";
import { ArenaRunRail } from "@/features/arena/ArenaRunRail";
import { ArenaRunView, type ArenaView } from "@/features/arena/ArenaRunView";
import { useNow } from "@/features/arena/arenaVocabulary";

export function ArenaSurface({
  transport,
  feed,
  host,
}: {
  transport: AgentHttpTransport;
  /** The machine's data source, which the contestants' sessions are read through. */
  feed: SidecarDataSource;
  host: HostActionsClient;
}) {
  const [runs, setRuns] = useState<ArenaRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [composing, setComposing] = useState(true);
  const [detail, setDetail] = useState<ArenaRunDetail | null>(null);
  const [view, setView] = useState<ArenaView>("sessions");
  // Held here rather than in the composer, so moving to a run and back keeps what was typed;
  // cleared only once the sidecar has taken it as a run.
  const [draft, setDraft] = useState<ArenaDraft>(EMPTY_DRAFT);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The stream, from the first paint: a run that closes while the tab sits open says so without
  // the reader asking, which is the difference between a duel and a list somebody has to check.
  useEffect(() => {
    const off = transport.subscribe(STREAM_PATH, {
      onMessage: (payload) => {
        const frame = parseRunsStreamFrame(payload);
        if (frame) setRuns(frame);
      },
      // A dropped stream is EventSource's to reconnect, and the one-shot fetch below re-reads
      // the list on any later remount -- so there is nothing here to say to a reader.
      onError: () => {},
    });
    return off;
  }, [transport]);

  // The one-shot fetch covers a sidecar that restarted mid-stream or a reader who reloaded.
  useEffect(() => {
    void fetchArenaRuns(transport).then((held) => {
      setRuns((current) => (current.length > 0 ? current : held));
    });
  }, [transport]);

  // The selected run's facts, re-read whenever any of its contestants moved. The stream carries
  // status only -- files and diffs ride the detail route -- so this is where the facts arrive.
  const selected = runs.find((run) => run.runId === selectedRunId) ?? null;
  const statusKey = useMemo(
    () => JSON.stringify(selected?.contestants.map((c) => [c.contestantId, c.status, c.sessionId]) ?? null),
    [selected],
  );
  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }
    let live = true;
    void fetchArenaRunDetail(transport, selectedRunId).then((next) => {
      if (live) setDetail(next);
    });
    return () => {
      live = false;
    };
  }, [transport, selectedRunId, statusKey]);
  // A detail read for the run the reader just left is not this run's.
  const shownDetail = detail && detail.runId === selectedRunId ? detail : null;

  const anyLive = runs.some((run) =>
    run.contestants.some((c) => c.status === "running" || c.status === "preparing"),
  );
  const now = useNow(anyLive);

  const start = useCallback(async () => {
    setStarting(true);
    setProblem(null);
    const answer = await createArenaRun(transport, {
      prompt: draft.prompt,
      repoPath: draft.repoPath.trim(),
      contestants: draft.lineup,
    });
    setStarting(false);
    if ("run" in answer) {
      // The repository and the lineup are kept: the next run is most often the same duel asked
      // a different question.
      setDraft((current) => ({ ...current, prompt: "" }));
      setRuns((current) =>
        current.some((run) => run.runId === answer.run.runId) ? current : [answer.run, ...current],
      );
      setSelectedRunId(answer.run.runId);
      setComposing(false);
      setView("sessions");
      return;
    }
    setProblem(answer.message);
  }, [transport, draft]);

  const tearDown = useCallback(async () => {
    if (!selectedRunId) return;
    setDeleting(true);
    setProblem(null);
    const answer = await deleteArenaRun(transport, selectedRunId);
    setDeleting(false);
    if ("message" in answer) {
      setProblem(answer.message);
      return;
    }
    setSelectedRunId(null);
    setComposing(true);
  }, [transport, selectedRunId]);

  // What a lane's `SessionView` needs from its surface, built from this tab's own machine. Mode
  // and cache hits are the reader's toggles across every lane at once: a comparison read raw in
  // one lane and nice in the next is not a comparison.
  const [eventMode, setEventMode] = useState<EventMode>("nice");
  const [showCacheHits, setShowCacheHits] = useState(false);
  const windowComposers = useMemo(
    () => ({
      claude: sidecarWindowComposerClient(feed, "claude"),
      codex: sidecarWindowComposerClient(feed, "codex"),
    }),
    [feed],
  );
  const context = useMemo<SessionViewContext>(
    () => ({
      feed,
      host,
      eventMode,
      onToggleEventMode: () => setEventMode((mode) => (mode === "nice" ? "raw" : "nice")),
      showCacheHits,
      onToggleCacheHits: () => setShowCacheHits((shown) => !shown),
      windowComposers,
      // A lane is a narrow column: its tasks panel presents as a sheet over it.
      compact: true,
      tasksHost: null,
    }),
    [feed, host, eventMode, showCacheHits, windowComposers],
  );

  const selectRun = useCallback((runId: string) => {
    setSelectedRunId(runId);
    setComposing(false);
    setProblem(null);
  }, []);

  return (
    <div data-arena-surface className="@container flex h-full min-h-0 bg-background text-foreground">
      <div className="flex min-h-0 w-full flex-col @3xl:flex-row">
        <aside className="flex max-h-56 shrink-0 flex-col border-b border-border @3xl:max-h-none @3xl:w-72 @3xl:border-r @3xl:border-b-0">
          <ArenaRunRail
            runs={runs}
            selectedRunId={selectedRunId}
            composing={composing}
            now={now}
            onSelect={selectRun}
            onCompose={() => {
              setComposing(true);
              setProblem(null);
            }}
          />
        </aside>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {composing || !selectedRunId ? (
            <ArenaNewRun
              draft={draft}
              onDraft={setDraft}
              starting={starting}
              problem={problem}
              onStart={() => void start()}
            />
          ) : selected ? (
            <ArenaRunView
              key={selected.runId}
              run={selected}
              detail={shownDetail}
              view={view}
              onView={setView}
              now={now}
              feed={feed}
              context={context}
              deleting={deleting}
              problem={problem}
              onDelete={() => void tearDown()}
            />
          ) : (
            <p className="px-5 py-8 text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground">
              That run is no longer listed.
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
