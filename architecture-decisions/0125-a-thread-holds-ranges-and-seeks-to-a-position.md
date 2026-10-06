---
status: proposed
date: 2026-10-05
---

# A thread holds ranges of its transcript, and seeks to a position instead of paging to it

## Context and Problem Statement

ADR-0124 named every transcript row by the byte its line starts at, so that any portion of a
transcript can be reached by seeking to a position. The panel never took that step. A thread
(`features/activity-feed/useSessionEventsStream.ts`) still holds one continuous window, from the
oldest row loaded down to the live end, and only grows it upward a page at a time (`loadOlder`).
Three things are built on that assumption, and each one is wrong because of it:

- **The user bar** (`sticky-headers/`) is computed from loaded rows. When none of the reader's own
  messages is loaded, `useUnloadedLastMessage` asks the sidecar for the session's newest message,
  which answers "the newest message" rather than "the last thing said above where you are reading".
  Measured 2026-10-05 on a live session whose newest message was `/compact`: the sidecar answered
  with it, the panel refused it as a command, and the bar was blank.
- **The jump** from that bar pages backwards until the message is loaded. On that session the
  message sat about 3MB above the end, which is dozens of page requests and every row in between
  laid out and measured, to show one row.
- **Restoring the reader's place** (`scroll-position/useTranscriptScrollRestore.ts`) pages back from
  the top in the same way, with the feed hidden while it does.

Holes do occur today, after a reconnect outruns a window, and `useTimelineGapFill` fills the newest
one at once. It is the only code that treats the held rows as anything but one run.

## Decision Drivers

- Reaching a row costs the page around it, never the transcript between it and the reader.
- What the panel shows is computed from what is loaded plus at most one bounded read, with no index
  or cache kept on either side (ADR-0124's second driver).
- A thread whose rows are all loaded behaves exactly as it does today.
- One rule for "the last thing the reader said", applied the same wherever the reader is.

## Considered Options

- **Keep one window and make paging faster**: larger pages, prefetching. Still costs the distance.
- **A turn index**: the sidecar lists every message the reader wrote, the panel holds it whole.
  Answers the bar anywhere, but building it is a whole-file read, which ADR-0124 removed.
- **Ranges and gaps**: the panel holds any number of contiguous ranges, a gap between two is a row
  of its own that loads as it comes on screen, and a jump or restore opens a range at a position.
  The bar's one remote question is "the last message said before this position", answered by a
  backward read that stops at the first match.

## Decision Outcome

Chose **ranges and gaps**. It is the only option whose cost tracks what is on screen; the faster
window still pays the distance, and the turn index reintroduces the whole-file read.

- **Ranges are derived, not stored.** Every row carries `previous` (ADR-0124), so where one range
  ends and a gap begins is read off the held rows. The thread keeps no range list to drift from them.
- **Reads.** A page may be asked for `before` a position (as now), `after` one, or `around` one
  (`EventsPageAt` in `agent-feed/wire`, which both ends build and parse the query from). A page
  carries no "where it ends": every row carries `previous`, so the held row below a gap already
  says whether a page reached it. Runtime-backed sources answer all three by arithmetic, as they
  answer `before` today.
- **Gaps.** A gap is a row in the feed. It loads a page when it comes within the virtualizer's
  overscan, from the side the reader is approaching it from, until it closes: from below a page
  read `before` the row under it, from above a page read `after` the row over it. Either way the
  row at the top of the viewport is not the gap, so the virtualizer's end anchor keeps what the
  reader is looking at still while the page lands. This replaces `useTimelineGapFill`, which paged
  a reconnect's hole closed at once wherever the reader was; now that hole waits until the reader
  scrolls to it, like any other.
- **The user bar** stands for the last message the reader said above the top row on screen. Inside
  the range holding that row it is found among loaded rows, by the rules that exist. When that range
  holds none above it, the sidecar is asked for the last such message before the range's start:
  `last-message?before=<position>&said=1`, a backward read that stops at the first match. The panel
  keeps that one answer while the range's start is unchanged; a message the reader sends arrives in
  the stream and is found locally.
- **"Said"** is one rule in `agent-feed/wire`: a message that only runs a slash command is not
  something the reader said. Both ends import it.
- **Jump and restore** open a range around the position (`around`) and scroll to the row. One read.
- **Older paging** is unchanged: `windowStart` is the start of the oldest range.
- **Layout** (`rows/activityFeedLayout.ts`) stops runs of tool calls and visual segments at a gap,
  and still pairs results with calls across the whole held set.

### Consequences

- Good, because a jump, a restore and the bar each cost one bounded read wherever the target is.
- Good, because the accidental hole and the deliberate one are the same thing, handled once.
- Bad, because the feed draws a row that is not a transcript line, and every consumer of
  `rowItems` has to pass over it (the sticky rules, the restore anchor, the virtualizer's sizing).
- Bad, because a remote bar answer can be up to one read stale against a message written into a
  gap. A gap only exists above the reader's newest loaded range, where nothing new is written.
- Neutral, because the scroll height is no longer the distance through the session, which ADR-0124
  already gave up.

### Confirmation

- A jump to an unloaded message makes exactly one events request (Chrome for Testing network log)
  and lands the row at the top of the viewport.
- A thread with every row loaded renders the same rows, bars and scroll positions as before
  (the paging and sticky sequences recorded in the ledger's checks).
- Route tests for `after`, `around` and `last-message?before&said`, a nice-mode page around a
  machinery line, and the runtime-backed arithmetic for all three.

## Links

- ADR-0124 A transcript row is named by the byte its line starts at
- `TASKS.md`, "Seekable threads"
