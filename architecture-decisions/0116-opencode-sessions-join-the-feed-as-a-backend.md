---
status: accepted
date: 2026-09-22
---

# Opencode sessions join the feed as a backend, not a transcript

## Context and Problem Statement

Opencode runs its sessions behind `opencode serve`, which owns a SQLite store and a typed HTTP plus SSE API. The feed already has two shapes for sessions: transcript adapters that parse one JSONL line (`SourceAdapter.processLine`), and provider backends that serve pages and subscriptions (`AgentBackend`). Opencode had to land behind one of them, with its web UI, TUI, and serve untouched.

## Decision Drivers

- No second copy of a store the serve already owns: rows read from SQLite would drift from the serve the moment either side changed.
- The serve's first-party JS SDK (`@opencode-ai/sdk`) already covers list, messages, prompt, abort, fork, permissions, and the event stream, so hand-rolled HTTP would be a second client to maintain.
- The serve password must never enter the panel; it stays in the sidecar like every other backend secret.
- Thinking blocks stream as a real lifecycle but carry empty text when the provider encrypts them; the feed must show that as thinking, not as nothing.

## Considered Options

- **Option A**: A transcript adapter that reads the serve's SQLite and synthesizes JSONL lines.
- **Option B**: An `AgentBackend` over the SDK client, with the catalog listing sessions off the serve.
- **Option C**: Embedding the serve's web UI beside the feed.

## Decision Outcome

Chose **Option B** because the backend seam already serves non-transcript sources end to end (the timeline route falls through to `backend.page` plus `backend.subscribe` for anything without a transcript adapter), which answers the drift driver that kills Option A: the serve stays the durable record and the sidecar keeps only a projection. Option C was rejected because the serve UI is a separate SolidJS app, not importable components, and an iframe would split composer, meter, and canvas integration.

### Consequences

- Good, because catalog, timeline, composer send/steer/abort, and permission/question mirrors all work with no panel feature code: they key off capabilities and the shared timeline path.
- Good, because live updates cost one shared serve event stream per sidecar, fanned out per session, with each event collapsing into a coalesced message re-read: no stream id to track, no delta to lose.
- Bad for backend projections generally, because indices are backend-owned and can renumber; the opencode exception is recorded in the update below.
- Bad, because the generated SDK snapshots one OpenAPI revision; a serve upgrade can drift it, which the live contract probe guards.
- Neutral, because `Session.transcriptPath` is now optional: backend-owned records omit it and every transcript-only reader answers not-found for them.

### Confirmation

`opencodeAgentBackend.test.ts` and `opencodeEventMapper.test.ts` pin translation and commands against a fake serve; `opencodeCatalog.test.ts` pins listing, pruning, and the unconfigured case; the panel renders an opencode thread in debug Chrome against the live serve.

## Update 2026-09-24: compaction streams beside the thread, not through a re-read

The serve's compaction writes no durable message until it lands (the checkpoint is inserted on
`session.next.compaction.ended`), so collapsing every serve event into a message re-read left the
feed silent for the minutes the summariser streamed -- and the desktop streams exactly that: live
start, deltas, and completion of the summary in its timeline. The pool now folds
`session.next.compaction.started` / `.delta` / `.ended` into a message-id-keyed watch
(`opencodeCompactionWatch.ts`, mirroring `claudeCompactionWatch.ts`), and the backend answers the
timeline's existing compaction probe, so the same `compacting` / `compaction-summary` notice the
panel already draws for Claude covers opencode with no panel code. Deltas never re-read (they
arrive per token with nothing new to fetch); the end and `session.compacted` do, which is also
what picks up the durable `compaction` row the mapper already translated. No failed/cancelled
compaction event exists in the pinned SDK snapshot, so a checkpoint landing without its `ended`
settles the notice by session, and a 15-minute timer backstops a dropped stream the way Claude's
does.

## Update 2026-09-25: opencode projections claim stable indices

The generic backend timeline contract still treats a projection as renumbering, which keeps Pi
conservative. Opencode is the exception: its projection upserts by the serve's stable message id
and appends new rows, so an opening snapshot sent again after a stream reconnect describes the
same rows. Its timeline now sets `stableIndices: true`, allowing the panel to retain pages the
reader has already loaded instead of replacing them with the newest window. A pool rebuild after
the session has been reaped remains a separate lifecycle boundary.

## Update 2026-09-25: a projection identity separates reconnect from restart

`stableIndices` answers whether a snapshot can be merged with rows the reader already holds. It
does not answer whether the sender is still the same projection. A sidecar restart rebuilds the
OpenCode pool and rehydrates a new `LiveAgentProjection`, which may assign the same indices to
different rows. The timeline now carries an optional `projectionId`, generated once per projection
instance and included in pages and envelopes. The panel retains paged history only when the id is
unchanged; a new id replaces the held rows before the saved scroll anchor is reapplied.

The panel also keeps a restore pending while an anchor older than the opening window is being
paged in. The feed continues measuring its rows, but hides the opening window behind a restore
notice until the exact event is loaded, so the first loaded row is never presented as the reader's
saved place. A real wheel, touch, or key input cancels the pending restore and hands control back
to the reader.
