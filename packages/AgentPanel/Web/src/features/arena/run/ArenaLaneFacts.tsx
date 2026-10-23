// The head of one lane: who the contestant is, where it stands, and the facts worth reading.
//
// One compact band, because the lane's work -- its session or its diff -- is what the reader came
// for, and every row of frame above it is a row of work pushed off the screen. So the band holds:
// the contestant and its status, the session's own controls on the same line (portalled in by the
// session under it) with the way into its worktree, then a line of facts, and a thin bar for its
// time.
//
// A fact is shown when it says something. Counts of files read and written are always worth
// comparing, zero included, once a contestant has settled; reaching outside its folder, a diff, its
// context and cost appear only when there is one to report, and a failure only when it failed. A
// settled lane that reached nowhere and changed nothing therefore just doesn't mention either, which
// reads at a glance where a row of "none" had to be read. The facts keep one order in every lane,
// so two lanes still compare along the line.
//
// The arena judges nothing, so nothing here ranks -- no winner, no highlighted best. Durations
// share one scale (the slowest lane is the full bar), because "how much longer" is what a time is
// read for, and a number alone answers it only after arithmetic.

import type { ReactNode } from "react";
import type { ArenaContestantDetail } from "@agentdesk/agent-feed-wire";
import { diffStat, elapsedMs, formatDuration, formatTokens } from "@/features/arena/run/arenaFacts";
import { laneLabel, StatusMark, TEXT } from "@/features/arena/arenaVocabulary";

const BAR_INK: Record<ArenaContestantDetail["status"], string> = {
  preparing: "bg-muted-foreground",
  starting: "bg-muted-foreground",
  ready: "bg-foreground/40",
  running: "bg-arena-running",
  closed: "bg-foreground/35",
  failed: "bg-destructive",
};

export function ArenaLaneFacts({
  contestant,
  slowestMs,
  now,
  controlsRef,
  browse,
}: {
  contestant: ArenaContestantDetail;
  /** The longest time of any lane in the run, which is this bar's full width. */
  slowestMs: number;
  now: number;
  /** Where the session under this head portals its controls, on the head's first line. */
  controlsRef?: (host: HTMLElement | null) => void;
  /** The way into the contestant's worktree, at the end of the head's first line. */
  browse?: ReactNode;
}) {
  const ms = elapsedMs(contestant, now);
  const stat = diffStat(contestant.gitDiff);
  // Files, diff and usage are recorded when a contestant closes. Before that they are unknown,
  // which is not the same fact as zero, so they are left out rather than counted.
  const settled = contestant.status === "closed" || contestant.status === "failed";
  return (
    <section
      aria-label={`${contestant.contestantId} ${laneLabel(contestant)} facts`}
      className="relative flex min-w-0 flex-col gap-1 bg-background px-3 pt-2 pb-2.5"
    >
      <header className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className={`${TEXT.title} font-semibold text-foreground`}>
          <span className="font-mono">{contestant.contestantId}</span> {laneLabel(contestant)}
        </h3>
        <StatusMark status={contestant.status} />
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {controlsRef ? <span ref={controlsRef} className="flex flex-wrap items-center gap-1" /> : null}
          {browse}
        </span>
      </header>
      <dl className={`flex flex-wrap items-baseline gap-x-4 gap-y-1 ${TEXT.meta}`}>
        {contestant.model ? (
          <Fact label="Model" caption="model">
            <span className="font-mono">{contestant.model}</span>
          </Fact>
        ) : null}
        {ms === null ? null : (
          <Fact label="Time">
            {formatDuration(ms)}
            {contestant.status === "running" ? <span className="text-muted-foreground"> so far</span> : null}
          </Fact>
        )}
        {settled ? (
          <Fact label="Files read" caption="read">
            {contestant.filesRead.length}
          </Fact>
        ) : null}
        {settled ? (
          <Fact label="Files written" caption="written">
            {contestant.filesWritten.length}
          </Fact>
        ) : null}
        {stat.files > 0 ? (
          <Fact label="Diff" caption={`in ${stat.files} ${stat.files === 1 ? "file" : "files"}`}>
            <span className="text-arena-added">+{stat.added}</span>{" "}
            <span className="text-arena-removed">−{stat.removed}</span>
          </Fact>
        ) : null}
        {settled && contestant.outsideReached.length > 0 ? (
          <Fact label="Outside its folder">
            <OutsideReach contestant={contestant} />
          </Fact>
        ) : null}
        {contestant.contextTokens !== null ? (
          <Fact label="Context" caption="context">
            {formatTokens(contestant.contextTokens)}
          </Fact>
        ) : null}
        {contestant.costUsd !== null ? <Fact label="Cost">${contestant.costUsd.toFixed(4)}</Fact> : null}
      </dl>
      {contestant.error ? (
        <p className={`line-clamp-2 break-words ${TEXT.meta} text-destructive`} title={contestant.error}>
          <span className="font-medium">Failure</span> {contestant.error}
        </p>
      ) : null}
      {ms === null ? null : (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-transparent">
          <span
            className={`block h-full transition-[width] duration-500 ${BAR_INK[contestant.status]}`}
            style={{ width: `${Math.max(2, (ms / Math.max(1, slowestMs)) * 100)}%` }}
          />
        </span>
      )}
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
  const rivals = [...new Set(reaches.flatMap((reach) => (reach.rival === null ? [] : [reach.rival])))];
  const places = new Set(reaches.map((reach) => reach.path)).size;
  return (
    <span className="text-destructive" title={reaches.map((reach) => `${reach.how}: ${reach.path}`).join("\n")}>
      {places} {places === 1 ? "place" : "places"} outside
      {rivals.length > 0 ? ` · into ${rivals.join(", ")}` : null}
    </span>
  );
}

/**
 * One fact: its value at full ink, then a short caption where the value alone would not say what it
 * counts. The full name is there for a screen reader, which reads it first.
 */
function Fact({ label, caption, children }: { label: string; caption?: string; children: ReactNode }) {
  return (
    <div>
      {/* Visually hidden on purpose, so the layout sweep's clipped-text check is told to pass it. */}
      <dt className="sr-only" data-sweep-ignore>
        {label}
      </dt>
      <dd className="tabular-nums text-foreground">
        {children}
        {caption ? <span className="text-muted-foreground"> {caption}</span> : null}
      </dd>
    </div>
  );
}
