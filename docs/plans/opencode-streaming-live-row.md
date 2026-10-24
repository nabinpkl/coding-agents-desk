# opencode streaming as a live row

> Plan only (2026-10-18). Nothing here is built. Read against the code before starting: every
> path and rule below was true on the day it was written.

## Why

An opencode turn reaches the panel as a durable row that is rewritten on every delta from the
serve. A Claude turn reaches it as a live row beside a durable list that does not move while
the turn streams. Both draw through the same `ActivityFeed`, so the difference is all in what each
delta costs:

| | Claude | opencode |
| --- | --- | --- |
| Durable rows from | the jsonl transcript (`subscribeTranscriptTimeline`) | the backend's one `LiveAgentProjection` (`timelineRoutes.ts`, the `else if (backend)` branch) |
| Message being written from | the live mirror's projection, as `{type: "tail"}` (`attachTail`) | the same projection, as `{type: "timeline"}` upserts |
| `canStreamLive` | `true` (`claudeLiveFlows.ts`) | `false` (`opencodeAgentBackend.ts`) |
| Panel handler per delta | `onLiveTail`: `liveRows` only | `onEvent`: a new `events` map, `retireLiveRows` over every event, and `buildFeedLayout` over the whole session in `useFeedRows` |

The per-delta writer is `OpencodeSessionPool.streamPart`, which calls `mapper.sync([message])`
on every `session.text.*` / `session.reasoning.*` delta with no coalescing (since d7c6a369,
2026-09-25). On a long session every word rebuilds the feed's layout.

What this cost first was scroll: content growing on every frame snapped the follower on every
frame, and the reader could not scroll up mid-turn. That is fixed in `useStickToBottom` on its
own (a reader's upward input now outranks the snap) and does not depend on this plan. What
remains is the cost: a whole-feed rebuild per delta.

## The change

Stream an opencode turn the way Claude's is streamed: the running message travels as a live
row, and the durable projection carries only what the serve has written.

### Sidecar

1. **A stream channel beside the projection.** `streamPart` stops calling `mapper.sync`. It hands
   the message the stream tail builds (`OpencodeStreamTail.apply`, unchanged) to a per-session
   listener set instead, already mapped by the same `OpencodeEventMapper.translate`, so the live
   row has exactly the durable row's shape. Map it without touching the projection: `translate` is
   private today and `sync` is the only way in, so either expose a pure `draw(message)` or
   give the stream its own throwaway `LiveAgentProjection`. The first is cleaner; the projection's
   revision counter is the only thing the second buys, and the panel keys live rows by id.
2. **The durable read leaves the running message out.** `refresh()` currently substitutes the
   merge (`mergedRead`) for the running message so the durable row never thins. With the stream
   carrying that message, the durable read should not publish it while it is open: drop the
   message `this.streaming.settle` still reports as running from `drawable` before `sync`, and
   publish it once the read shows it finished. That keeps "a message this draws is never thinner
   than the row it replaces" true across the hand-off, since the hand-off is now live row to
   finished durable row.
3. **A tail subscription on the backend.** `AgentBackend.subscribe` is the durable stream, and
   `attachTail` in `timelineRoutes.ts` subscribes to it. Claude can do that only because its
   durable rows come from the transcript, not the backend. Add an optional
   `subscribeTail(sessionId, listener)` to `AgentBackend`; `attachTail` uses it where present and
   `subscribe` where not, so Claude and Codex are unchanged. Opencode implements it from step 1's
   listener set, and sets `canStreamLive: true`.
4. **Close the tail.** When the step's durable read lands, send `{type: "tail", event: null}`
   for that message, or rely on the panel's retirement (below). Prefer retirement: a null clears
   every live row at once, and a turn is several messages.

### Panel

5. **Name the message.** `retireLiveRows`, `visibleTails` and `splitLiveTails` all match on
   `event.messageId`. The opencode mapper sets only `id: "opencode:<message id>"`. Set `messageId`
   on both the live and the durable row (the serve's message id).
6. **The retirement rule assumes Claude's file.** `retireLiveRows` retires a live row when it is
   `complete`, or when the file holds one line per content block; `splitLiveTails` splits a live
   message into one row per block because Claude's transcript writes one line per block. Opencode's
   durable row is ONE row with every block. So:
   - splitting would draw the live message as N rows and hand off to one row, which moves the
     reader's place at every hand-off. Do not split an opencode tail; the cleanest test is "the
     source writes a message as one row", carried on the snapshot or the capabilities rather
     than a `source === "opencode"` check in the panel;
   - retirement by "one line per block" never fires for a one-row message (one line, several
     blocks); retirement by the durable row being `complete` does. That is the only rule opencode
     needs, and it is already one of the two.
7. **Index spaces.** A live row's `index` is a position in the stream's own numbering, not the
   projection's (the same split Claude already has: see the comment on `collapsedTails` in
   `useFeedRows.ts`). `retireLiveRows` retires every live row up to the newest named one by
   `index`, so the stream must number its rows in message order. Either reuse the durable
   projection's index for the message (known once the message has an id) or number in the stream.

### Tests

- Sidecar: `opencodeSessionPool.stream.test.ts` already drives deltas; assert a delta reaches the
  tail listener and publishes nothing on the projection, and that the closing read publishes the
  durable row once.
- Route: `timelineRoutes.test.ts`, a backend with `subscribeTail` gets its tail from there.
- Panel: `useSessionEventsStreamLiveRow.test.tsx` style, an opencode tail is retired by its
  `complete` durable row, is not split, and never appears twice.

## Open questions

- **Does the turn stay readable across a sidecar restart mid-turn?** Today the running message is
  in the durable projection and a reopened stream's snapshot carries it. After the change it is
  in the stream only; a reader who opens mid-turn needs the stream's current message replayed on
  subscribe, as Claude's `attachTail` does by replaying the projection.
- **Tool parts mid-turn.** The durable read brings tool calls the deltas never name. With the
  running message held out of the durable projection, a tool call in flight shows only once the
  stream tail has the read's record merged in (`OpencodeStreamTail` already keeps the read's parts
  under the stream's words), so the live row must be redrawn on each read too, not only on deltas.
- **Is the rebuild worth this?** Measure first: `buildFeedLayout` time per delta on the longest
  opencode session. If it is a few milliseconds, coalescing the deltas in the sidecar to one per
  frame (~16 to 50ms) gets most of the gain for a handful of lines, and this plan can wait.
