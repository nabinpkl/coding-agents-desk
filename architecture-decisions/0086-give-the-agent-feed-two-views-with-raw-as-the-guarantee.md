---
status: accepted
date: 2026-07-30
---

# Give the agent feed two views, with the raw one as the fidelity guarantee

## Context and Problem Statement

The Agent Panel renders one row per transcript JSONL line. Measured on this project's
own transcripts, that makes the tail of a thread unreadable: the last 100 rows of the
largest Codex session carried 2 rows of agent prose, and reaching five meant scrolling
back 257 rows. Most of what fills those rows is harness bookkeeping — `token_count`
records that each supersede the last, hook telemetry, encrypted reasoning blobs — and
tool call/output pairs, which are 54 of every 100 rows.

Omitting any of it conflicts with a standing requirement that every JSONL line be
renderable, and hiding lines is also how a panel silently stops showing a record type
a future harness release invents. This touches
`agent-feed/sidecar/src/transcripts/` (the index and both source adapters), the
`AgentDeskWire` agent-feed messages, `AgentFeedBridge`, `AgentPanelRequest`, and the
panel's `activityDisplayItems` / `ActivityFeed`.

## Decision Drivers

- Every JSONL line must be reachable in the UI, not merely in the file.
- A harness update that adds a record type must not make rows disappear.
- Event indices address transcripts of hundreds of megabytes; a page's indices must
  resolve to the lines that page delivered, and a mismatch must not be silent.
- The phone and the Mac panel share one webview and one wire, so per-surface policy
  is not available.

## Considered Options

- **Option A**: One curated view. Drop machinery outright, no way back.
- **Option B**: Two views — `raw` renders every line, `nice` omits machinery and folds
  tool runs — with the mode travelling on the wire and a second index in the sidecar.
- **Option C**: One view, filtered client-side. The sidecar keeps sending everything;
  the panel hides rows it judges uninteresting.

## Decision Outcome

Chose **Option B**. Option A fails the first driver outright: once a line has no row,
nothing recovers it. Option C keeps fidelity but fails the paging driver — the panel
pages by event index over a 338 MB file, so a client-side filter makes a "100 event"
page an unpredictable number of visible rows, and a thread whose window is mostly
machinery pages repeatedly to fill a screen. Putting the policy in the sidecar makes a
100-event nice page exactly 100 content events.

The nice view is allowed to omit **because** the raw view is one press away. That is
the whole load-bearing relationship: the guarantee is what licenses the omission, so
the raw view stays flat, one row per line, and never clusters.

Three rules make the mode safe to carry:

- Machinery is an explicit deny-list; **content is the default**. An unrecognized
  record type shows up as an unfamiliar row rather than vanishing.
- An **absent** mode means `raw` at every boundary it crosses (webview decoder, QUIC
  wire, HTTP query, panel buffer), so a peer that predates modes keeps working and
  means the fidelity view when it says nothing.
- A **present but unrecognized** mode is refused everywhere rather than defaulted.
  Guessing would answer with indices counted in a view the caller did not ask for.

The second index stores nice-event-N → **raw event index**, not a byte offset, so a
nice event's byte offset is one array read away and no second copy of the offsets can
drift. Raw → nice is a binary search plus a local counter over the window being read,
so no reverse map is stored either.

### Consequences

- Good, because the tail becomes readable: Claude 3,591 rows → 1,591, with prose going
  19 per 100 rows to 53; Codex 20,217 → 11,577, 17 to 53 counting the prose it records
  as a labelled `Agent Message`.
- Good, because context occupancy left the transcript entirely and became a live header
  readout, removing 19% of the rows in the measured Codex session.
- Bad, because switching modes remounts the feed and lands at the tail. Every index the
  feed holds is mode-relative, and seeding at the viewer's position instead would leave
  a hole between that window and the live tail, which the feed's event store cannot
  represent. Events carry their counterpart index so a later change can close this.
- Neutral, because clustering ended the 1:1 display-item-to-event correspondence that
  four parts of the feed read directly; they go through `leadEvent` / `itemKey` now.

### Confirmation

`readEvents` re-parses every line in the byte span between two indexed lines, and in
nice mode the omitted lines are still physically inside that span. Failing to re-apply
the classification there does not error — the page looks right while every index in it
addresses a different line. `eventIndex.test.ts` pages through an interleaved
transcript in both modes and resolves each returned index back to the line it
delivered; that test is the only place this failure is visible.

Per-harness agreement between each adapter's renderer and the classifier is pinned in
`lineClass.test.ts`: whatever renders as a reasoning block is content, and whatever
renders as the encrypted placeholder is not. The two share one text scan for exactly
this reason.

## Links

- SPEC — agent feed sidecar and Agent Panel
- ADR-0075 Load the agent feed by visible layer
- ADR-0074 Own the agent feed source inside AgentDesk (superseded by ADR-0075)
