// One prompt fanned out to contestants, and the facts each left behind: the arena surface.
//
// A run is read here, not judged. The surface shows where each contestant stands while the run
// duels, what it read and wrote, how long it took and what it spent once it closes, and the
// diff it left -- and every judge of those is the reader. A contestant's session is an ordinary
// session in every surface that already lists sessions; this tab exists to group the run and
// carry the facts, not to become a second transcript reader.
//
// The register is the panel's own: a dense operator surface on its existing tokens, one table
// of runs with the selected run's contestants under it. Everything here is a status surface --
// preparing, running, closed, failed -- and the four states get four readings, never a colour
// alone carrying a meaning the text does not.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createArenaRun,
  deleteArenaRun,
  fetchArenaRunDetail,
  fetchArenaRuns,
  parseRunsStreamFrame,
  STREAM_PATH,
} from "@/features/arena/arenaRunsSource";
import type {
  ArenaContestantDetail,
  ArenaContestantStatus,
  ArenaRunDetail,
  ArenaRunSummary,
} from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";

const STATUS_LABEL: Record<ArenaContestantStatus, string> = {
  preparing: "preparing",
  running: "running",
  closed: "closed",
  failed: "failed",
};

/**
 * Status as a reading, not a colour: running is the only state with motion on it, and failed
 * is the only one with the icon. A colour alone would leave the states apart only for a reader
 * who can see them, which is the one thing this panel does not assume of itself.
 */
const STATUS_CLASS: Record<ArenaContestantStatus, string> = {
  preparing: "text-muted-foreground",
  running: "text-primary",
  closed: "text-foreground",
  failed: "text-destructive",
};

function duration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function factsLine(contestant: ArenaContestantDetail): string {
  const read = contestant.filesRead.length;
  const written = contestant.filesWritten.length;
  const files = `${read} read · ${written} written`;
  const cost = contestant.costUsd === null ? "cost unknown" : `$${contestant.costUsd.toFixed(4)}`;
  return `${duration(contestant.durationMs)} · ${files} · ${cost}`;
}

export function ArenaSurface({ transport }: { transport: AgentHttpTransport }) {
  const [runs, setRuns] = useState<ArenaRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArenaRunDetail | null>(null);
  const [prompt, setPrompt] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [contestantCount, setContestantCount] = useState(2);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The stream, from the first paint: a run that closes while the tab sits open says so without
  // the reader asking, which is the difference between a duel and a list of tasks somebody has
  // to remember to check.
  useEffect(() => {
    const off = transport.subscribe(STREAM_PATH, {
      onMessage: (payload) => {
        const frame = parseRunsStreamFrame(payload);
        if (frame) setRuns(frame);
      },
      // A dropped stream is EventSource's to reconnect, and the one-shot fetch above re-reads
      // the list on any later remount -- so there is nothing here to say to a reader.
      onError: () => {},
    });
    return off;
  }, [transport]);

  // The one-shot fetch covers a sidecar that restarted mid-stream or a reader who reloaded; the
  // stream carries every change after it. Empty on a frame it cannot read, never a throw.
  useEffect(() => {
    void fetchArenaRuns(transport).then((held) => {
      setRuns((current) => (current.length > 0 ? current : held));
    });
  }, [transport]);

  // The selected run's facts, re-read whenever any of its contestants moved. The stream carries
  // status only -- the diff rides the detail route -- so this is where the facts are fetched.
  const selectedStatusKey = useMemo(
    () => JSON.stringify(runs.find((run) => run.runId === selectedRunId)?.contestants.map((c) => [c.contestantId, c.status]) ?? null),
    [runs, selectedRunId],
  );
  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }
    void fetchArenaRunDetail(transport, selectedRunId).then(setDetail);
  }, [transport, selectedRunId, selectedStatusKey]);

  const start = useCallback(async () => {
    setStarting(true);
    setProblem(null);
    const answer = await createArenaRun(transport, {
      prompt,
      repoPath: repoPath.trim(),
      contestants: contestantCount,
    });
    setStarting(false);
    if ("run" in answer) {
      setPrompt("");
      setSelectedRunId(answer.run.runId);
      return;
    }
    setProblem(answer.message);
  }, [transport, prompt, repoPath, contestantCount]);

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
  }, [transport, selectedRunId]);

  const selected = runs.find((run) => run.runId === selectedRunId) ?? null;
  const nothingSelected = selectedRunId !== null && selected === null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      <header className="shrink-0 border-b border-border px-4 py-3">
        <h1 className="text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold">Arena</h1>
        <div className="mt-2 grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] items-start gap-2">
          <textarea
            aria-label="Prompt every contestant gets"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="The one prompt this run fans out"
            rows={2}
            className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2 py-1 text-(length:--agent-panel-fs-sidebar-body,15px) outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <input
            aria-label="Repository the contestants work in"
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            placeholder="Repository path"
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-(length:--agent-panel-fs-sidebar-body,15px) outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <div className="flex items-center gap-2">
            <label className="text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground" htmlFor="arena-contestants">
              Contestants
            </label>
            <select
              id="arena-contestants"
              value={contestantCount}
              onChange={(event) => setContestantCount(Number(event.target.value))}
              className="rounded-md border border-border bg-background px-1 py-1 text-(length:--agent-panel-fs-sidebar-body,15px) outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {[1, 2, 3, 4].map((count) => (
                <option key={count} value={count}>{count}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void start()}
              disabled={starting || !prompt.trim()}
              className="min-h-11 rounded-md border border-border px-3 text-(length:--agent-panel-fs-sidebar-body,15px) font-medium outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary active:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {starting ? "Starting" : "Start run"}
            </button>
          </div>
        </div>
        {problem ? (
          <p role="alert" className="mt-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
            {problem}
          </p>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {runs.length === 0 ? (
          <p className="px-4 py-6 text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground">
            No runs yet.
          </p>
        ) : (
          <ul aria-label="Arena runs" className="divide-y divide-border border-b border-border">
            {runs.map((run) => (
              <li key={run.runId}>
                <button
                  type="button"
                  aria-pressed={run.runId === selectedRunId}
                  onClick={() => setSelectedRunId(run.runId)}
                  className={`flex w-full items-baseline gap-3 px-4 py-2.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset ${
                    run.runId === selectedRunId ? "bg-muted" : ""
                  }`}
                >
                  <span className="shrink-0 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
                    {run.contestants
                      .map((contestant) => STATUS_LABEL[contestant.status])
                      .join(" · ")}
                  </span>
                  <span className="min-w-0 grow truncate text-(length:--agent-panel-fs-sidebar-body,15px)">
                    {run.prompt}
                  </span>
                  <span className="shrink-0 font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
                    {run.repoPath}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {selected ? (
          <section aria-label="Contestants" className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-(length:--agent-panel-fs-sidebar-meta,13px) font-semibold text-muted-foreground">
                {selected.baseRef} of {selected.repoPath}
              </h2>
              <button
                type="button"
                onClick={() => void tearDown()}
                disabled={deleting || selected.contestants.some((c) => c.status === "running" || c.status === "preparing")}
                className="min-h-11 rounded-md border border-border px-2 py-1 text-(length:--agent-panel-fs-sidebar-meta,13px) outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary active:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleting ? "Removing" : "Remove run"}
              </button>
            </div>
            <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3">
              {(detail?.contestants ?? []).map((contestant) => (
                <article
                  key={contestant.contestantId}
                  className="rounded-md border border-border p-3"
                >
                  <header className="flex items-baseline justify-between gap-2">
                    <h3 className="text-(length:--agent-panel-fs-sidebar-body,15px) font-semibold">
                      {contestant.contestantId}
                    </h3>
                    <span className={`text-(length:--agent-panel-fs-sidebar-meta,13px) ${STATUS_CLASS[contestant.status]}`}>
                      {contestant.status === "running" ? "◍ " : contestant.status === "failed" ? "✕ " : ""}
                      {STATUS_LABEL[contestant.status]}
                    </span>
                  </header>
                  <p className="mt-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
                    {contestant.status === "closed" || contestant.status === "failed"
                      ? factsLine(contestant)
                      : STATUS_LABEL[contestant.status]}
                  </p>
                  {contestant.sessionId ? (
                    <p className="mt-1 truncate font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
                      {contestant.sessionId}
                    </p>
                  ) : null}
                  {contestant.error ? (
                    <p className="mt-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
                      {contestant.error}
                    </p>
                  ) : null}
                  {contestant.filesRead.length > 0 ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        Read {contestant.filesRead.length}
                      </summary>
                      <ul className="mt-1 space-y-0.5 font-mono text-(length:--agent-panel-fs-sidebar-meta,13px)">
                        {contestant.filesRead.map((file) => (
                          <li key={file} className="truncate">{file}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {contestant.gitDiff ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        Diff
                      </summary>
                      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/40 p-2 font-mono text-(length:--agent-panel-fs-sidebar-meta,13px)">
                        {contestant.gitDiff}
                      </pre>
                    </details>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        ) : nothingSelected ? (
          <p className="px-4 py-6 text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground">
            That run is no longer listed.
          </p>
        ) : null}
      </div>
    </div>
  );
}