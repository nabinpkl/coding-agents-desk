---
status: accepted
date: 2026-10-04
---

# A transcript row is named by the byte its line starts at

## Context and Problem Statement

A Claude or Codex transcript was served through an event index (`transcripts/event-index/`, now
removed) that numbered every line from the top of the file. A row could not be named, counted or
paged until the whole file had been parsed, and the index was dropped when its last reader left.
Every page load therefore re-parsed every open card's transcript, on the sidecar's one thread.

Measured 2026-10-04 in Chrome for Testing against the live panel with ten canvas cards open (about
330MB of transcript):
- **Index build:** about 3.4ms per MB, so 464ms for one 136MB transcript, on every reload.
- **First row on a card:** 2.0 to 2.5s cold, with the last card at 2.9 to 3.9s.
- **Unrelated routes:** a 2ms `/input` call queued behind the parsing for 0.76 to 1.4s.

With the indexes held by another tab, the same cards drew in 0.9 to 1.0s. The parse was the cause.

## Decision Drivers

- Opening a card must cost the size of the window it shows, not the size of the session.
- No state to rebuild after a reload or a sidecar restart; the live supervisor restarts the
  sidecar on every edit to it.
- The owner does not need a total row count (said 2026-10-04): the scroll area may grow upward as
  older pages load.

## Considered Options

- **Keep the index after its last reader leaves**, with an idle timeout. Cheap, but it does not
  survive a sidecar restart, and a first open still pays the whole parse.
- **Persist the index to disk.** Survives restarts, but adds a cache that can go stale, and a first
  open still pays the whole parse.
- **Name a row by its byte position and read pages backwards from a position.** The opening window
  is the end of the file; any other portion is reached by seeking to a position.

## Decision Outcome

Chose **byte positions**. It is the only option whose cost does not grow with the session, and a
transcript only grows at the end, so a line's starting byte never changes. The two index options
were knocked out by the first two drivers.

- **Addressing.** A row's `index` is that byte, the same number in the raw and nice views, and its
  id is `<source>:<session>:at:<byte>`. Each row carries `previous`, the row before it in the same
  view or null at the first one. Positions are not adjacent numbers, so neighbours and gaps are
  read off `previous`.
- **Paging.** Pages are `?before=<position>&limit=` (the newest page omits `before`). A page
  answers with `windowStart`: its oldest row's index when older rows exist, and 0 when none do.
  Runtime-backed sources (opencode, Pi) keep ordinal indices and answer the same parameters with
  arithmetic (`backendPageBefore`).
- **Follows.** A follow (`transcripts/transcript-reads/transcriptFollow.ts`) keeps only a cursor and
  the meter, starting where the reader's opening page ended.
- **Meter.** Usage and the declared model are read back from the end, plus the top 256KB for a
  model declaration.

### Consequences

- Good, because the ten-card load measured 0.92s cold to the first row and 1.14s to the last, and
  0.67s and 0.79s warm. `/input` answers in about 4ms during a load. A 136MB transcript's newest
  page is 23ms.
- Good, because a card opens on the timeline stream's own snapshot. The panel no longer asks for a
  row count and then a page, which StrictMode was also doubling.
- Bad, because the wire has no total row count. Nothing on screen used it.
- Bad, because the meter is reconstructed from the end of the file rather than folded from the top.
  A session whose only tiered model declaration lies between the first 256KB and the last 2MB to
  16MB of its file shows the untiered window until its next declaration.
- Neutral, because scroll positions remembered before this change name row numbers. They are kept
  under a new storage key (`agent-panel.transcript-scroll.positions`), so old ones are forgotten
  rather than misread as positions near the top of the file.

### Confirmation

`transcript-reads/transcriptPages.test.ts` pins the backward page, the `previous` chain across
pages, the first-row stop, lines longer than one read, and the follow. The panel's
`useSessionEventsStreamGap.test.tsx` pins gap detection by `previous` with indices 1000 apart.
