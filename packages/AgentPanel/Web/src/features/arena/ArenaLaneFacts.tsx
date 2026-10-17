// The top of one lane: who the contestant is, where it stands, and the facts it left.
//
// Every lane carries the same rows at the same fixed height, so laid side by side the facts form
// rows across the lanes: a reader compares "files written" by reading along one line, and the
// lane's session or diff sits directly under its own facts. The arena judges nothing, so nothing
// here ranks -- no winner, no highlighted best. Durations share one scale (the slowest lane is
// the full bar) because "how much longer" is what a time is read for, and a number alone answers
// it only after arithmetic.

import type { ReactNode } from "react";
import type { ArenaContestantDetail } from "@agentdesk/agent-feed-wire";
import { diffStat, elapsedMs, formatDuration, formatTokens } from "@/features/arena/arenaFacts";
import { SOURCE_LABEL, StatusMark, TEXT } from "@/features/arena/arenaVocabulary";

/** Which optional rows this run shows: a row any lane needs is shown in every lane, to align. */
export interface FactRows {
  cost: boolean;
  failure: boolean;
}

export function factRowsFor(contestants: readonly ArenaContestantDetail[]): FactRows {
  return {
    cost: contestants.some((contestant) => contestant.costUsd !== null),
    failure: contestants.some((contestant) => contestant.error !== null),
  };
}

const BAR_INK: Record<ArenaContestantDetail["status"], string> = {
  preparing: "bg-muted-foreground",
  starting: "bg-muted-foreground",
  ready: "bg-foreground/40",
  running: "bg-arena-running",
  closed: "bg-foreground/70",
  failed: "bg-destructive",
};

export function ArenaLaneFacts({
  contestant,
  slowestMs,
  rows,
  now,
}: {
  contestant: ArenaContestantDetail;
  /** The longest time of any lane in the run, which is this bar's full width. */
  slowestMs: number;
  rows: FactRows;
  now: number;
}) {
  const ms = elapsedMs(contestant, now);
  const stat = diffStat(contestant.gitDiff);
  const none = <span className="text-muted-foreground">—</span>;
  // Files, diff and usage are recorded when a contestant closes. Before that they are unknown,
  // which is not the same fact as zero, so they read as a dash rather than a count.
  const settled = contestant.status === "closed" || contestant.status === "failed";
  return (
    <section
      aria-label={`${contestant.contestantId} ${SOURCE_LABEL[contestant.source]} facts`}
      className="flex flex-col bg-background px-4 pt-3 pb-2"
    >
      <header className="flex items-baseline justify-between gap-2 pb-2">
        <h3 className={`${TEXT.title} font-semibold`}>
          <span className="font-mono">{contestant.contestantId}</span> {SOURCE_LABEL[contestant.source]}
        </h3>
        <StatusMark status={contestant.status} />
      </header>
      <dl className="flex flex-col">
        <Fact label="Time">
          {ms === null ? (
            none
          ) : (
            <span className="flex min-w-0 flex-1 items-center justify-end gap-3">
              <span aria-hidden className="h-1 w-full max-w-32 overflow-hidden rounded-full bg-muted">
                <span
                  className={`block h-full rounded-full transition-[width] duration-500 ${BAR_INK[contestant.status]}`}
                  style={{ width: `${Math.max(2, (ms / Math.max(1, slowestMs)) * 100)}%` }}
                />
              </span>
              <span className="shrink-0">
                {formatDuration(ms)}
                {contestant.status === "running" ? <span className="text-muted-foreground"> so far</span> : null}
              </span>
            </span>
          )}
        </Fact>
        <Fact label="Files read">{settled ? contestant.filesRead.length : none}</Fact>
        <Fact label="Files written">{settled ? contestant.filesWritten.length : none}</Fact>
        <Fact label="Outside its folder">{settled ? <OutsideReach contestant={contestant} /> : none}</Fact>
        <Fact label="Diff">
          {stat.files === 0 ? (
            <span className="text-muted-foreground">{contestant.status === "closed" ? "no change" : "—"}</span>
          ) : (
            <span className="inline-flex items-baseline gap-2">
              <span className="text-arena-added">+{stat.added}</span>
              <span className="text-arena-removed">−{stat.removed}</span>
              <span className={`${TEXT.meta} text-muted-foreground`}>
                in {stat.files} {stat.files === 1 ? "file" : "files"}
              </span>
            </span>
          )}
        </Fact>
        <Fact label="Context">
          {!settled ? (
            none
          ) : contestant.contextTokens === null ? (
            <span className="text-muted-foreground">not reported</span>
          ) : (
            `${formatTokens(contestant.contextTokens)} tokens`
          )}
        </Fact>
        {rows.cost ? (
          <Fact label="Cost">
            {contestant.costUsd === null ? (
              <span className="text-muted-foreground">not reported</span>
            ) : (
              `$${contestant.costUsd.toFixed(4)}`
            )}
          </Fact>
        ) : null}
        {rows.failure ? (
          // The last row, so it may wrap without moving any row a reader compares across.
          <Fact label="Failure" wraps>
            {contestant.error ? (
              <span className="line-clamp-2 text-right break-words text-destructive" title={contestant.error}>
                {contestant.error}
              </span>
            ) : (
              none
            )}
          </Fact>
        ) : null}
      </dl>
    </section>
  );
}

/**
 * How far outside its own worktree the contestant reached, with a rival's worktree said apart:
 * contestants run as plain agents, so a look at a rival's work is not refused, only recorded.
 * Every place is in the title; the Files view lists them.
 */
function OutsideReach({ contestant }: { contestant: ArenaContestantDetail }) {
  const reaches = contestant.outsideReached;
  if (reaches.length === 0) return <span className="text-muted-foreground">none</span>;
  const rivals = [...new Set(reaches.flatMap((reach) => (reach.rival === null ? [] : [reach.rival])))];
  const places = new Set(reaches.map((reach) => reach.path)).size;
  return (
    <span className="truncate" title={reaches.map((reach) => `${reach.how}: ${reach.path}`).join("\n")}>
      {places} {places === 1 ? "place" : "places"}
      {rivals.length > 0 ? (
        <span className="text-destructive"> · into {rivals.join(", ")}</span>
      ) : null}
    </span>
  );
}

/**
 * One fact row: fixed height, so the same row sits on one line across every lane. Only the last
 * row may `wraps`, since a taller last row moves nothing a reader compares.
 */
function Fact({ label, wraps = false, children }: { label: string; wraps?: boolean; children: ReactNode }) {
  return (
    <div className={`flex items-center justify-between gap-4 border-t border-border ${wraps ? "min-h-9 py-1.5" : "h-9"}`}>
      <dt className={`shrink-0 ${TEXT.meta} text-muted-foreground`}>{label}</dt>
      <dd className={`flex min-w-0 flex-1 justify-end ${TEXT.body} tabular-nums text-foreground`}>{children}</dd>
    </div>
  );
}
