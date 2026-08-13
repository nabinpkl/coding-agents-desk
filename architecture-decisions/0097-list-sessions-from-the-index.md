---
status: accepted
date: 2026-08-13
---

# List a project's sessions from the catalog index, never from transcript bodies

## Context and Problem Statement

Opening a project in the Agent Panel took six to eight seconds the first time. From the
running host's own log, `agent-feed-session-snapshot` reported `durationMs: 8175` for a
project with 306 sessions, and `durationMs: 1.03` on every read after it -- once per
sidecar spawn, so once per host relaunch.

The cause was a layering fault in `agent-feed/sidecar/src/transcripts/transcriptCatalog.ts`,
not a missing optimization. `SessionSummary` fused facts already in memory (id, source,
`lastEventAt`, capabilities) with facts that required opening a transcript (resolved title,
turn state). Because there was one type, asking for the cheap half computed the expensive
half for every session: `computeSessionSummaries` fired `Promise.all` over 306 probes, each
walking its whole file with a `JSON.parse` per line -- 292 MB of Claude transcripts plus the
Codex rollouts, to render the three rows the panel actually shows.

This is drift from ADR-0075, which accepted "probes its session headers and **bounded
tails**" as the cost of dropping the pre-computed digest. The probe was not bounded.

## Decision Drivers

- ADR-0075's own rule -- the projects screen must not read transcript bodies -- applies one
  screen down, to the session list, for the same reason.
- ADR-0075 rejected a persistent store on the grounds that "a v0 cache must justify its
  consistency cost with measured latency". Any fix here must not reintroduce one.
- A session row renders five things: what it sorts by, the live signal, the title, the
  updated time, and which agent owns it. Four are already in memory.
- The cheap layer already pays for the whole corpus: `agent-feed-catalog-ready` is 190-529 ms
  for 1237 sessions across 51 projects, against 7000 ms for one project's probes.

## Considered Options

- **Option A**: Page the probe -- read only the first N sessions a viewer can see.
- **Option B**: Persist a session index to disk and reload it at spawn.
- **Option C**: Move the two body-only facts into the bounded metadata read that already
  discovers the session, and make listing a projection over records already held.

## Decision Outcome

Chose **Option C**. Option A leaves the fused type in place, so the cost returns the moment a
viewer scrolls, and it makes the sort order depend on how much has been read -- the list
sorts by `lastEventAt`, which comes from the catalog, so a paged probe would have to read
everything anyway to sort correctly. Option B is the store ADR-0075 rejected, and it has to
justify a consistency cost that Option C does not incur at all.

The measurement that settles it: `claudeAdapter.readHeader` already read 32 KB from each end
of every Claude transcript at reconcile, to learn `cwd`, and already extracted `aiTitle` and
`customTitle`. Across this repo's 119 Claude transcripts, **113 carry their title inside
those two windows**. Of the six that do not, five have no title anywhere in the file, so the
whole-file scan found nothing for them either. The expensive read was buying one title in
119.

So the two missing facts -- turn state and opening prompt -- were added to that same read.
For Claude they cost **zero additional I/O**: the bytes were already in the buffer, and
`onClaudeCandidate` re-runs the read on every write, so they stay fresh. Codex learns its
inventory from SQLite and so needed a new bounded `readTail`, restricted to sessions inside
`liveWindowMs`, because that is the only window in which the answer can change which bin a
row lands in.

Nothing about the wire changed. `SessionSummary` keeps its exact shape, only the provenance
of its fields moved, so no protocol version moves and no client ships.

### Consequences

- Good, because a cold `GET /api/sessions` for the 306-session project went from **7000 ms to
  1.1 ms**, measured standalone against the real store, and the whole-corpus reconcile stayed
  at 190 ms.
- Good, because the probe's supporting machinery is gone: the incremental byte cursor, the
  per-session probe map, the promise-valued summary memo with its generation keying and
  failure eviction, and the inventory stream's per-project generation counters that existed
  only to order asynchronous reads. Listing is now synchronous.
- Good, because the one rule that decides "is this turn open" now has a single home per
  adapter, read both by the line parser and by the bounded metadata read. It used to be
  written twice and was free to disagree with itself about what live means.
- Bad, because a title reachable only from the middle of a long transcript is no longer
  found. On this corpus that is **1 session in 119**, and it falls back to its opening
  prompt, which still identifies it.
- Bad, because six Codex sessions that Codex itself never titled now render as their id.
  They previously rendered identical `<recommended_plugins>` harness boilerplate scraped from
  their first user message, which named them no better. Recovering that would cost a head
  read of all 1053 Codex rollouts to reproduce a string that identifies nothing.
- Neutral, because a live badge could in principle be missed if a session's last 32 KB
  carries no turn-boundary line. Only inside the two-minute window, and an actively-writing
  session is exactly where recent boundary lines are.

### Confirmation

Three standing signals:

- `transcriptCatalog.test.ts` lists a project **with its transcripts deleted from disk** and
  asserts the rows still render their titles. If listing ever opens a body again, every row
  falls back to its id and the test fails.
- `boundedSessionRead.test.ts` pins what the two windows yield AND that content outside them
  is invisible, so widening the read is a deliberate act rather than a silent one. It also
  asserts the two readers of each turn rule agree.
- The title-equals-id count on the real corpus, which is what the fidelity trade is measured
  in. It is **6 of 306** today, all Codex. A jump in that number is a source that stopped
  answering.

## Pros and Cons of the Options

### Option A -- page the probe

- Good, because it is a small diff and leaves every existing shape alone.
- Bad, because the sort key comes from the catalog, so a correct sort still needs every
  session; paging only defers the read, it does not remove it.
- Bad, because it keeps identity and content fused in one type, which is the actual defect.

### Option B -- persist a session index

- Good, because it survives sidecar restarts, which is where the cost is paid.
- Bad, because it is the store ADR-0075 rejected, and it adds a second home for facts whose
  first home is the transcript. Option C makes the read cheap enough that there is nothing
  left to persist.

## Links

- ADR-0075 visibility-scoped no-cache Agent feed subscriptions (this extends its rule and
  closes its "bounded tails" drift)
- ADR-0091 provider-neutral agent sidecar backends
- SPEC §38 AgentFeedSidecar
