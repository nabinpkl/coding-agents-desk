// One run, read side by side: what was asked, then one lane per contestant -- its facts on top,
// and under them its session or its diff -- or the matrix of files every contestant touched.
//
// A lane is one contestant from top to bottom. Its facts sit directly over its own session, so a
// reader never matches a number in one table to a transcript in another; and since every lane
// carries the same fact rows at the same height, the facts still read across as rows. The lanes
// share one horizontal scroll, so on a narrow screen they move together and stay aligned.
//
// The switch between sessions, files and diffs stays put above the lanes, on the line under the
// prompt: a reader flicks between views of one run, and a switch that moved with its view would
// move out from under the finger.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import type { ArenaRunDetail, ArenaRunSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { SessionViewContext } from "@/features/session-view/SessionView";
import { DiffLane } from "@/features/arena/ArenaDiffs";
import { ArenaFilesMatrix } from "@/features/arena/ArenaFilesMatrix";
import { ArenaLaneFacts, factRowsFor } from "@/features/arena/ArenaLaneFacts";
import { SessionLane, useRunSessions } from "@/features/arena/ArenaSessionLanes";
import { lineupKind } from "@/features/arena/ArenaNewRun";
import { basename, diffStat, elapsedMs, fileMatrix, formatAgo } from "@/features/arena/arenaFacts";
import { FOCUS, ICON_BUTTON, TEXT } from "@/features/arena/arenaVocabulary";

export type ArenaView = "sessions" | "files" | "diffs";

export function ArenaRunView({
  run,
  detail,
  view,
  onView,
  now,
  feed,
  context,
  deleting,
  problem,
  onDelete,
}: {
  run: ArenaRunSummary;
  /** The facts, which arrive on their own request; null until they have. */
  detail: ArenaRunDetail | null;
  view: ArenaView;
  onView: (view: ArenaView) => void;
  now: number;
  feed: SidecarDataSource;
  context: SessionViewContext;
  deleting: boolean;
  problem: string | null;
  onDelete: () => void;
}) {
  const [promptOpen, setPromptOpen] = useState(false);
  const live = run.contestants.some((c) => c.status === "running" || c.status === "preparing");
  const settled = run.contestants.filter((c) => c.status === "closed" || c.status === "failed").length;
  const contestants = detail?.contestants ?? [];
  const fileCount = fileMatrix(contestants).filter((row) => row.inRepository).length;
  const changed = contestants.filter((c) => diffStat(c.gitDiff).files > 0).length;
  const long = run.prompt.length > 280 || run.prompt.split("\n").length > 4;
  const slowestMs = Math.max(1, ...contestants.map((c) => elapsedMs(c, now) ?? 0));
  const rows = factRowsFor(contestants);
  const directories = [run.repoPath, ...run.contestants.map((c) => c.worktreePath)];
  const { sessions, error: catalogError } = useRunSessions(feed, directories);

  const views: { name: ArenaView; label: string; count: number | null }[] = [
    { name: "sessions", label: "Sessions", count: null },
    { name: "files", label: "Files", count: fileCount },
    { name: "diffs", label: "Diffs", count: changed },
  ];

  return (
    <article aria-label="Arena run" className="flex min-h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-5 pt-5 pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p
              className={`whitespace-pre-wrap break-words text-lg leading-snug font-medium text-foreground ${long && !promptOpen ? "line-clamp-4" : ""}`}
            >
              {run.prompt}
            </p>
            {long ? (
              <button
                type="button"
                onClick={() => setPromptOpen((open) => !open)}
                aria-expanded={promptOpen}
                className={`mt-1 rounded ${TEXT.meta} text-muted-foreground underline-offset-2 hover:text-foreground hover:underline ${FOCUS}`}
              >
                {promptOpen ? "Show less" : "Show the whole prompt"}
              </button>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Remove run"
            title={live ? "A run cannot be removed while it is dueling" : "Remove run and its worktrees"}
            onClick={onDelete}
            disabled={deleting || live}
            className={`${ICON_BUTTON} hover:text-destructive`}
          >
            <Trash2 aria-hidden className="size-4" />
          </button>
        </div>
        <p className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${TEXT.meta} text-muted-foreground`}>
          <span>{lineupKind(run.contestants.map((c) => c.source))}</span>
          <span aria-hidden>·</span>
          <span className="font-mono" title={run.repoPath}>{basename(run.repoPath)}</span>
          <span aria-hidden>@</span>
          <span className="font-mono">{run.baseRef}</span>
          <span aria-hidden>·</span>
          <span>{formatAgo(run.createdAt, now)}</span>
          <span aria-hidden>·</span>
          <span className={live ? "text-arena-running" : ""}>
            {live ? `${settled} of ${run.contestants.length} settled` : "settled"}
          </span>
        </p>
        {problem ? (
          <p role="alert" className={`${TEXT.meta} text-destructive`}>{problem}</p>
        ) : null}
      </header>

      <div className="sticky top-0 z-20 flex shrink-0 items-center border-b border-border bg-background px-5">
        <div role="tablist" aria-label="Compare by" className="-mb-px flex gap-4">
          {views.map((one) => (
            <button
              key={one.name}
              type="button"
              role="tab"
              aria-selected={view === one.name}
              onClick={() => onView(one.name)}
              className={`flex min-h-10 items-center gap-1.5 border-b-2 border-transparent px-0.5 ${TEXT.body} text-muted-foreground transition-colors duration-150 hover:text-foreground aria-selected:border-foreground aria-selected:text-foreground ${FOCUS}`}
            >
              {one.label}
              {one.count !== null && detail ? (
                <span className={`rounded bg-muted px-1.5 ${TEXT.meta} tabular-nums text-foreground`}>
                  {one.count}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" aria-label={views.find((one) => one.name === view)?.label} className="flex min-h-0 flex-1 flex-col">
        {!detail ? (
          <p className={`px-5 py-6 ${TEXT.meta} text-muted-foreground`}>Reading the facts.</p>
        ) : (
          <>
            {catalogError && view === "sessions" ? (
              <p role="alert" className={`px-5 py-2 ${TEXT.meta} text-destructive`}>
                The session catalog did not answer: {catalogError}
              </p>
            ) : null}
            <LaneGrid lanes={contestants.length} tall={view === "sessions"}>
              {contestants.map((contestant) => (
                <ArenaLaneFacts
                  key={`facts-${contestant.contestantId}`}
                  contestant={contestant}
                  slowestMs={slowestMs}
                  rows={rows}
                  now={now}
                />
              ))}
              {view === "sessions"
                ? contestants.map((contestant) => (
                    <SessionLane
                      key={`session-${contestant.contestantId}`}
                      contestant={contestant}
                      listed={contestant.sessionId ? sessions.get(contestant.sessionId) ?? null : null}
                      context={context}
                    />
                  ))
                : view === "diffs"
                  ? contestants.map((contestant) => (
                      <DiffLane key={`diff-${contestant.contestantId}`} contestant={contestant} />
                    ))
                  : null}
            </LaneGrid>
            {view === "files" ? <ArenaFilesMatrix contestants={contestants} /> : null}
          </>
        )}
      </div>
    </article>
  );
}

/**
 * The lanes' shared grid: one column per contestant, its facts in the first row and the chosen
 * view in the second, scrolled sideways together. When the lanes are wider than the screen, the
 * edge they continue past fades, since an overlay scrollbar shows nothing until it is used.
 */
function LaneGrid({ lanes, tall, children }: { lanes: number; tall: boolean; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => {
      setEdges({
        left: node.scrollLeft > 1,
        right: node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
      });
    };
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [lanes]);
  return (
    <div className="relative">
      <div ref={scroller} className="overflow-x-auto">
        <div
          className="grid min-w-full gap-x-px bg-border"
          style={{
            gridTemplateColumns: `repeat(${lanes}, minmax(min(22rem, 86vw), 1fr))`,
            // A session lane is a whole session -- transcript and composer -- so it gets most of
            // a screen rather than whatever is left under the facts.
            gridTemplateRows: tall ? "auto max(32rem, calc(100dvh - 11rem))" : "auto auto",
          }}
        >
          {children}
        </div>
      </div>
      {edges.left ? (
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent" />
      ) : null}
      {edges.right ? (
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent" />
      ) : null}
    </div>
  );
}
