// The list of runs down the arena's left edge, and the way into a new one.
//
// A row is read for its prompt first -- that is what tells two runs apart -- so the prompt is the
// row's content at full ink, its name a caption after the lineup, and its lineup a strip of lane chips: one per contestant, the
// harness's initial inside, the lane's status as its ink and border. A row's hover and selected
// fills are half of `--muted`: the full fill takes the row's muted caption under 4.5:1. A glance down the rail says
// which runs are still dueling and which lanes failed, without opening any of them.

import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import type { ArenaContestantSummary, ArenaRunSummary } from "@agentdesk/agent-feed-wire";
import { basename, formatAgo } from "@/features/arena/arenaFacts";
import {
  BUTTON,
  FOCUS,
  isLive,
  SOURCE_INITIAL,
  SOURCE_LABEL,
  TEXT,
} from "@/features/arena/arenaVocabulary";

const CHIP_INK: Record<ArenaContestantSummary["status"], string> = {
  preparing: "border-border text-muted-foreground",
  starting: "border-border text-muted-foreground",
  ready: "border-border text-foreground",
  running: "border-arena-running text-arena-running",
  closed: "border-border text-foreground",
  failed: "border-destructive text-destructive",
};

export function ArenaRunRail({
  runs,
  selectedRunId,
  composing,
  now,
  browse,
  onSelect,
  onCompose,
}: {
  runs: readonly ArenaRunSummary[];
  selectedRunId: string | null;
  /** The composer is what the main column shows, so "New run" reads as the current place. */
  composing: boolean;
  now: number;
  /** The way into the arena home's files, beside "New run" once its path is known. */
  browse?: ReactNode;
  onSelect: (runId: string) => void;
  onCompose: () => void;
}) {
  return (
    <nav aria-label="Arena runs" className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 py-2.5">
        <h2 className={`${TEXT.title} mr-auto font-semibold`}>Runs</h2>
        {browse}
        <button
          type="button"
          onClick={onCompose}
          aria-pressed={composing}
          className={`${BUTTON} min-h-8 px-2.5 aria-pressed:bg-muted`}
        >
          <Plus aria-hidden className="size-4" />
          New run
        </button>
      </div>
      {runs.length === 0 ? (
        <p className={`px-3 pb-3 ${TEXT.meta} text-muted-foreground`}>No runs on this machine yet.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {runs.map((run) => {
            const selected = run.runId === selectedRunId && !composing;
            const live = run.contestants.some(isLive);
            return (
              <li key={run.runId}>
                <button
                  type="button"
                  onClick={() => onSelect(run.runId)}
                  aria-current={selected ? "true" : undefined}
                  className={`group relative flex w-full flex-col gap-1.5 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-muted/50 aria-[current=true]:bg-muted/50 ${FOCUS}`}
                >
                  {selected ? (
                    <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-foreground" />
                  ) : null}
                  <span className={`line-clamp-2 ${TEXT.body} leading-snug ${run.prompt ? "text-foreground" : "text-muted-foreground"}`}>
                    {run.prompt || "Waiting for a prompt"}
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="flex shrink-0 gap-1">
                      {run.contestants.map((contestant) => (
                        <span
                          key={contestant.contestantId}
                          title={`${contestant.contestantId} · ${SOURCE_LABEL[contestant.source]} · ${contestant.status}`}
                          className={`inline-flex size-5 items-center justify-center rounded-sm border font-mono text-[11px] leading-none ${CHIP_INK[contestant.status]}`}
                        >
                          {SOURCE_INITIAL[contestant.source]}
                        </span>
                      ))}
                    </span>
                    <span className={`min-w-0 truncate ${TEXT.meta} text-muted-foreground`}>
                      {run.name} · {live ? (run.prompt ? "dueling" : "lanes open") : formatAgo(run.createdAt, now)}
                      {run.round > 1 ? ` · ${run.round} prompts` : null}
                      {run.repoCreated ? null : ` · ${basename(run.repoPath)}`}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
