# Handover — 2026-07-30

Branch `main`, HEAD `3e25106c`, in sync with `origin/main`, nothing uncommitted from
this arc. (Previous handovers are preserved in this file's git history.)

**Gate**: `just agent-feed-sidecar-check` (62 tests) and `just agent-panel-web-check`
(116 tests) green, plus `swift test` in `packages/AgentDeskWire` and
`packages/AgentPanel`. A **full `just check` currently fails on another session's
in-progress voice work**, not on this — see Gotchas.

## What shipped this session: two views over the transcript (ADR-0086)

The Agent Panel rendered one row per JSONL line. Measured on real transcripts, that
made the tail unreadable: the last 100 rows of the largest Codex session carried **2
rows of agent prose**, and reaching five meant scrolling back 257 rows.

There are now two views. **`raw`** renders every line, flat — the fidelity guarantee.
**`nice`** omits harness machinery and folds runs of tool work. Context occupancy left
the transcript entirely and became a live header readout. Rationale in **ADR-0086**.

| commit | what |
|---|---|
| `ffba11df` | context occupancy as a live header meter, not 7,197 rows |
| `ececb678` | the machinery/content classifier (`sources/lineClass.ts`) |
| `07941fde` | second index + mode carried end to end |
| `78f290cc` | raw-mode labels (attachment subtypes, tool-label fallback, encrypted reasoning) |
| `a52ad66c` | nice-mode clustering of tool runs |
| `6ccf9e35` | ADR-0086 |
| `3e25106c` | omit the duplicated `agent_message` notification |

End to end on the largest Claude transcript (53 MB) and Codex rollout (339 MB):

| | Claude | Codex |
|---|---|---|
| rows, raw → nice | 3,591 → 1,591 (56% fewer) | 20,217 → 8,582 (58% fewer) |
| tail-window prose per 100 rows | 19 → 53 | 17 → 39 |

## Settled design — do not relitigate

- **Fidelity is never traded.** The nice view may omit **because** the raw view is one
  press away. That relationship is load-bearing: the raw view stays flat and never
  clusters.
- **Machinery is an explicit deny-list; content is the DEFAULT.** A record type a
  future harness release invents shows up as an unfamiliar row rather than vanishing.
  This polarity is the one thing the design cannot get wrong.
- **An absent mode means `raw`** at every boundary (webview decoder, QUIC wire, HTTP
  query, panel buffer). A **present but unrecognized** mode is refused everywhere,
  because guessing answers with indices counted in a view the caller did not ask for.
- **Token `limit` arrives resolved from the sidecar.** Neither panel holds model
  knowledge. Null is a real answer and renders a bare count, never a guessed fraction.
- **No dedup by content.** Omissions are per-record-type rules, each measured first.

## Where things live

Sidecar, `agent-feed/sidecar/src/transcripts/`:

- `sources/lineClass.ts` — the machinery/content tables and the rule. **The one place
  to change what the nice view omits.**
- `sources/claudeThinking.ts`, `sources/codexReasoning.ts` — "does this reasoning carry
  text", shared by each adapter's renderer **and** the classifier. Two copies would
  drift, and the failure is silent in the worst direction: a trace with real prose
  classified as machinery and dropped.
- `eventIndex.ts` — both indices, `readEvents`, `translateEventIndex`,
  `niceInsertionPoint`. `dropIndexState` is the single teardown for per-index state.
- `usageState.ts` — the sticky-usage merge; `config.ts` — `contextWindowFor`
  (prefix-keyed, `AGENT_FEED_CONTEXT_WINDOWS` override).

Panel, `packages/AgentPanel/Web/src/features/activity-feed/`:

- `activityDisplayItems.ts` — clustering, `leadEvent`, `itemKey`, `isSkillActivation`.
- `TokenMeter.tsx`, `eventModeStore.ts` — header readout, remembered mode.
- `ActivityFeed.tsx` — the feed; toggle and meter portal into the shell header.

Mode crosses four hand-mirrored boundaries. **Add a field and all four need it**, and
`normalizeActivityEvent` rebuilds events field by field, so one it does not name is
silently dropped:

```
sidecar JSON → AgentFeedActivityBlock/Event (host) → AgentDeskWire (abbreviated keys)
             → BridgeDataSource wire types (web) → app types
```

## Not yet done / next actions

1. **`Patch Applied` renders its raw payload. Fully investigated, ready to fix — and
   do NOT omit it.** It is not safely omittable the way `agent_message` was: of 3,219
   records across the six largest rollouts, 2,058 (64%) pair by `call_id` with an
   `apply_patch`/`exec_command` call whose output contains their `stdout`, but **1,161
   (36%) come from `apply_patch` run through an `exec` shell call and their
   confirmation appears nowhere else** — searching the next 40 tool outputs for each
   one's `stdout` found it in 0 of 1,161. Omitting would lose "did this edit land" for
   a third of all edits.

   The defect is the rendering: it falls through the generic `event_msg` branch to
   `metadataText(payload)`, so a row is raw payload JSON — **mean 3,343 chars (10.8 MB
   across those six files)** where the useful `stdout` is 170 chars, and **777 rows
   (24%) exceed the 4,096-char cap and are cut mid-diff**. It is the largest remaining
   non-prose row type in the Codex tail (10 per 100). Also 884 of 3,219 (27%) touch
   more than one file, so the file list is load-bearing; and `success: false` never
   occurs with `stderr` empty in all 3,219, so like the hooks the failure path has
   never rendered and is still worth writing.

   Fix: a named branch in `codexTranscript.ts` showing `stdout` (or a file list from
   `changes`), marking failure on `success === false`, full payload left to the Raw
   drawer. Mirrors the encrypted-reasoning fix in `78f290cc`. Feeding
   `changes.unified_diff` into the existing `DiffBlock` is larger and separable.

2. **Sweep the other `metadataText` payload dumps.** `patch_apply_end` reaches its dump
   by falling through the generic `event_msg` branch, so `Task Started`,
   `Task Completed`, `Item Completed`, `Thread Settings` and the rest very likely do
   the same. Measure as one group rather than one at a time.

3. **Mode switch loses the viewer's place — deliberately deferred.** Switching remounts
   the feed and lands at the tail. Seeding at the viewer's position opens a **hole**
   between that window and the live tail, and the feed's event store has no way to
   represent a gap: rows either side would render as adjacent when they are not.
   `otherModeIndex` is already on the wire and tested for exactly this, so the
   translation half is done; what is missing is an anchored subscribe plus gap
   handling in the store.

4. **`<oai-mem-citation>` renders as part of the agent's words**, in both views. A
   machine block riding inside assistant prose. Found while pairing `agent_message`
   with its record — it is the 170-char difference in the 85 pairs that were not
   byte-identical.

5. **Never run against a live host.** Everything here is verified against real
   transcripts and the host-free fixture; **no part of this arc has run through the
   actual host + sidecar + panel stack.** Under AGENTS.md that is a checkpoint: state
   the command and wait for a go-ahead.

6. **Still open from the previous handover** (2026-07-11, now 19 days old): the
   one-time donor import is gated on an absent destination store
   (`WorkspaceStore.loadOrImport`, host/AgentDeskHost/Workspace/WorkspaceStore.swift:264).
   Latent, not biting. Its other two items are closed — the ADR-0054 client shipped
   (marketing version is now `1.10.2`), and iOS having no rendered HTML *page* preview
   is a recorded design decision, not a bug.

## Corrections to the plan this arc was built from

`~/.claude/plans/ticklish-kindling-squirrel.md` has four claims measurement disproved.
**Trust this file over that one.**

1. **Claude has its own encrypted-reasoning case**, which the plan credited only to
   Codex: 587 rows (14% of the largest Claude file) are `thinking` blocks with an empty
   trace whose signature blob was dumped as a Plain card. Adding it took Claude
   omission 28% → 42% and doubled its tail prose.
2. **Codex skill detection needed no sidecar work.** 94% of `SKILL.md` references
   (3,123 of 3,322) fall inside the 200-char summary, **not 21%**. No wire field and no
   skill-root allowlist were needed.
3. **The sticky selectors needed no change.** They only read a row's `kind`, never its
   event, so clustering did not touch them and their tests still hold as written.
4. **The 6× prose-density projection was optimistic.** The real figure is 1.6–2.8×.

## Gotchas

- **Another session is editing this repo concurrently** (voice, `gesture-agent`,
  `VoiceLaneServer.swift`, `TASKS.md`, `SPEC.md`). A full `just check` failed twice
  during this arc on *their* in-progress code. Verify the two legs above separately
  before concluding anything from `just check`, and read `git status` before staging —
  `git add` of a shared file picks up their uncommitted work.
- **`just check` also has known intermittent flakes** (WebKit/pasteboard noise, QUIC
  lane and sidecar timing). Retry before investigating. (Also in agent memory.)
- **The one test that matters most is `eventIndex.test.ts`'s index/read agreement
  pass.** `readEvents` reads the byte span between two indexed lines and re-parses
  everything inside it; in nice mode the omitted lines are still physically in that
  span. Failing to re-apply the classification there **does not error** — the page
  looks correct while every index addresses a different line, surfacing as a Raw drawer
  showing the wrong line, a paging anchor landing wrong, and a mis-scrolled sticky
  jump. That test is the only place it is visible.
- **Measure the real surface; do not reason about CSS.** Every number here came from
  `just agent-panel-web`, then `http://localhost:5183/?fixture` at viewport **480×692**
  (the panel's content rect minus its NSPanel titlebar), read with
  `getBoundingClientRect`. Three of this arc's bugs got through code review and were
  caught only by measuring. The fixture derives both views from one tagged line list,
  the way the sidecar does, so it cannot disagree with itself about which line an index
  names.
- **Two raw-drawer tests were made deterministic in `a52ad66c`.** They clicked a
  `<summary>` and polled 1,000 ms; jsdom schedules `toggle` as a task and one run took
  1,027 ms under load. They now set `open` and dispatch `toggle` directly and release a
  held fetch by hand. Do not reintroduce a `waitFor` poll there.
- **`event_msg.agent_message` is omitted; `response_item.agent_message` is not.** Same
  name, different records (72,324 against 453). Do not merge the rule.
- **`user_message` is NOT a duplicate** despite the identical notification/record
  shape: 1,076 of its 1,085 pairs carry different text. A person's words stay in;
  there is a test pinning it.
- **Measure a duplication claim before acting on it.** The first attempt to pair
  `agent_message` with its record compared each notification against the *preceding*
  record and reported 0% identical. That was wrong — correct pairing gives 98.7% — and
  it nearly buried a 3,000-row win.
- Device and host launches are a checkpoint (AGENTS.md): prepare, state the command,
  then wait for "run it".
