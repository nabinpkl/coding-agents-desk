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

A compaction is also a replacement boundary inside one projection. The serve can rewrite the
message set, so a completed compaction in the tail makes the pool re-read the whole history and
rebuild the projection instead of upserting onto rows the serve has replaced. The rebuild rotates
`projectionId`, which is what makes an already-open card drop its old window; without that, a
compacted session could keep showing a pre-compaction tool call as its last line. Shell calls open
their command and result by default, because that output is the answer the row exists to give.

## Update 2026-09-26: the serve's deltas are the read, for a turn's words

A turn's prose and thinking are not a thing the panel goes and fetches. The serve publishes each
part as a lifecycle — `session.reasoning.started`, one `session.reasoning.delta` per chunk,
`session.reasoning.ended` carrying the whole part — and the durable message does not exist until
the step ends. Every one of those events used to fall through to the router's catch-all, which
schedules a re-read of the newest page, coalesced to one per 300ms. So a sentence arrived in
300ms steps, and each step re-read and re-mapped 200 messages to move one line of it. Measured on
a live turn: the text now grows in 85–135ms steps, which the coalesce could not produce, and the
whole turn costs no history read at all.

`OpencodeStreamTail` holds the parts of a running message in the order the serve opened them and
hands back a message shaped exactly like the durable one, so the existing mapper draws the streamed
row with the rules the settled row uses and the durable read replaces it by id, in place. The
shape is deliberately minimal — `type`, `time.created`, `content` — because that is all the
mapper's assistant branch reads, and a cast is the honest way to say a synthesized envelope is
not a promise about the whole `SessionMessage` union.

Four seams decide what is drawn, and each is a place where the cheaper answer would be a lie:

- **A part is not drawn before it has words.** `started` names a part that is empty; drawing the
  row and filling it a moment later is a flash, not a stream.
- **A delta for a part this tail never saw open is dropped.** The sidecar was not watching when
  the serve opened it, so there is no base text to extend, and inventing one would silently drop
  the words that came before. The durable read settles it instead.
- **A streamed message never carries `time.completed`.** Its row reads as streaming however long
  the words run, because the read at the end of the step is what closes it, and that read is also
  what brings the tool parts, tokens and cost the deltas never name.
- **A read is the STARTING RECORD for the stream, not the end of it.** This one was measured
  rather than reasoned. The serve inserts a message into its history while the step is still
  writing it, so a read that names the running message is a snapshot of a row mid-write. Treating
  the first such read as the answer dropped the tail, and the next delta rebuilt a message holding
  only the part it had seen since -- a thinner record that replaced a row which had a reasoning
  block in it. On a live turn the row drew as a thinking line, went text-only at the next delta,
  and the thinking came back when the step ended: a rewind a reader watches happen, which is what
  "the tail is overwritten and settles on the transcription" looks like from the outside.

So a read is merged rather than obeyed. A message the read draws as finished is dropped, because
that is the one moment the durable row is the whole story. A message the read draws as still being
written is adopted, whether or not the tail already holds it, so a delta arriving afterwards
extends what the row already shows. Where both know a part, the longer text wins: a read can be
behind the stream still writing it, and a read can carry words no delta ever sent. The invariant
is that a streamed upsert is never thinner than the row it replaces, which is the whole of it.

 - **The merge is the only draw, and it is drawn in the read's place.** The invariant above was not
   enough on its own, and the way it failed is worth recording because it is the same bug one layer
   down. Reconciling the tail's memory while the projection kept the read's row left the repair
   invisible: the row went thin, and the next delta or the next read put it back. Measured on a live
   turn, with the serve's own message for the id the stream was writing reading
   `reasoning: 0, tool: shell running` while the stream held 583 characters of reasoning -- the serve
   writes that part at the end. So a tool call, which deliberately buys a read, emptied the thinking
   out of the row, and the thinking came back on the following read. A repair the next event would
   eventually reveal is a repair the reader watched the row go without.

   The row is therefore built once, from both records: the durable message's parts in the durable
   order, each text part's words taken from the stream, and any part the serve has not written yet
   appended in the order the stream opened it. That merge is substituted into the page the read
   returned and drawn once, in place of the read's own version of that message, so the read still
   supplies the page, the tokens, the tool parts and every other message. Two details are
   load-bearing rather than tidy. The decision about which record has more of a part belongs where
   the read is folded in, not where the row is built, because the stream is the accumulation the
   deltas append to and a read's text can only become its base; deciding at build time silently
   drops a sentence that arrives after a read which had caught up. And the substitution is what
   keeps a tool part from vanishing when the next sentence arrives, since a delta knows nothing
   about one.

Tool events deliberately still buy a read. A tool row needs its input, its output and its state
together, and the deltas carry them in pieces; a partial tool row is a call with no result under
it. An event of the word families that this shape cannot draw is dropped rather than read, since
falling through to a read would buy the same words later and more slowly.

The panel needed nothing for this. A growing row is an ordinary upsert on an index it may not hold
(`events.set(event.index, event)`, with `total` widened), the projection's `revision` rises with
each change so the merge accepts it, and the tail follower re-pins on a `ResizeObserver` over
measured height, so a row that grows in place keeps the reader at the bottom. The separate `tail`
channel stays for the backends that have a live mirror, and `canStreamLive` stays false here: this
is the projection streaming, not a mirror.
