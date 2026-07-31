# Handover — 2026-07-30

Branch `main`, in sync with `origin/main`, nothing uncommitted from this arc.
(Previous handovers are preserved in this file's git history.)

**Gate**: full `just check` green (exit 0), including `just agent-feed-sidecar-check`
(78 tests) and `just agent-panel-web-check`. The other session's in-progress voice work
that was failing `just check` earlier in this arc has since landed.

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

## Also shipped: `Patch Applied` is a file list, not a payload dump

The row now names what the edit touched: `4 files · M FileTab.swift, A Tests.swift,
D Old.swift`, from `changes` rather than `stdout` — structured, so it does not depend
on the harness's confirmation wording. `success === false` renders `Patch Failed` with
`stderr` and no file list (nothing landed). Measured by running the real adapter over
the same six rollouts, all 3,219 records:

| | before | after |
|---|---|---|
| mean row chars | 3,343 | **50** |
| max row chars | 55,121 | **274** |
| rows cut by the 4,096 cap | 777 (24%) | **0** |
| distinct collapsed previews | 1 | **1,562** |

That last row is why the summary comes from `changes`: every `stdout` starts
`Success. Updated the following files:`, and `eventPreview` keeps only the first line,
so 3,219 collapsed rows read identically. Six files are named before `+N more` (57
rows, 1.8%; the largest patch here touches 20). It stays **content** in the nice view —
verified, 0 of 3,219 classified machinery.

## Also shipped: every tool row says what it did (`sources/codexToolSummary.ts`)

Codex writes a tool call's arguments three ways and the adapter read one of them.
`function_call` carries JSON. `custom_tool_call` carries either JavaScript source
driving one `tools.<verb>(...)` call, or — for `apply_patch` — a bare patch document.
Neither of the latter two parses as JSON, so `parseArgs` returned `{}` and the row fell
to its bare tool name. Rows read `exec exec`, and the collapsed preview (`summary ||
tool`) made them mutually indistinguishable.

Measured over **832 rollouts / 817,754 lines**, running the real adapter before and
after:

| | before | after |
|---|---|---|
| distinct collapsed previews (146,566 tool rows) | 45,977 | **70,545** |
| rows reading as the bare tool name | 50,388 (34.4%) | **190 (0.1%)** |
| summaries silently cut at a newline by the preview | 3,322 | **0** |
| image-only tool results dropped entirely | 444 | **0** |

Coverage by population: all 17,065 `apply_patch` payloads (100%), 15,841 shell `exec`
scripts (98.4%), and 6,000 non-shell `exec` verbs (99.9%).

**How it works, and its one guarantee.** Two readers — one walking JavaScript source,
one walking a parsed JSON value — both emit an ordered list of `key -> scalar` pairs.
One rule table per verb then picks which key names the row (`cmd` for `exec_command`,
`session_id`+`chars` for `write_stdin`, the `*** <Verb> File:` headers for a patch,
`q`/`ref_id` for `web__run`, `step` for `update_plan`, `path` for `view_image`,
`message`/`targets` for the sub-agent verbs). A verb with no rule falls to its first
real argument, which covers the MCP and app-automation tail without a rule per server.
**No rule guesses.** One that cannot find its argument returns nothing and the row
names the verb instead — 256 `exec` calls build their commands in a loop, and the next
literal in that source is a `workdir`, so reporting it as the command would be worse
than saying nothing.

Three defects the measurement caught that reading the code would not have:

- The script reader must **step over string literals**, not scan inside them. A regex
  to `/cmd\s*:/` takes `echo "cmd: not-this"` as the real command.
- A patch **embedded in a script** writes its line breaks as the two characters
  backslash-n, which no line-oriented pattern stops at. Without cutting there the
  "path" ran on and pulled the whole diff into the row.
- Dispatching "is this a patch?" on *whether the text contains `tools.`* misreads a
  diff that adds a line mentioning `tools.` — it picks a verb out of the patched file's
  own contents. The opening line `*** Begin Patch` is the deterministic test (17,065 of
  17,065).

Two adjacent fixes rode along, same defect class:

- `input_image` blocks in a tool output were skipped by `joinTextContent` (their
  payload is a data: URI several hundred KB wide), so 444 outputs that carried nothing
  else vanished. They now read `[N images]`; the URI still never enters a row.
- A multi-line command lost everything after line 1 with no sign anything was dropped.
  Now `python - <<'PY'  (+3 more lines)`.

The summary drops a verb name that only repeats the chip the row already shows (that
duplication *was* `exec exec`), but keeps it in front of a bare argument value, which
needs it — and which is the convention the Claude adapter follows.

## Not yet done / next actions

1. **Sweep the other `metadataText` payload dumps — measured, not yet fixed.** Same six
   rollouts, one pass over every branch of `normalizedRecord` (script shape preserved in
   this session's notes; it mirrors the adapter's dispatch). Ranked by total rendered
   bytes, the ones a viewer still sees in **nice** mode:

   | record | rows | mean chars | over 4,096 cap | note |
   |---|---|---|---|---|
   | `event_msg/image_generation_end` | 18 | 1,982,648 | 100% | base64 image data |
   | `response_item/image_generation_call` | 13 | 2,156,464 | 100% | falls to `plain()`, 64 KB cap |
   | `event_msg/mcp_tool_call_end` | 244 | 126,563 | 45% | `result` payload |
   | `event_msg/user_message` | 1,090 | 14,262 | 3% | **a person's words wrapped in JSON** |
   | `event_msg/exec_command_end` | 2,096 | 4,758 | 46% | investigated, **closed** — see below |
   | `event_msg/web_search_end` | 348 | 3,964 | 36% | `query` + `results` |
   | `event_msg/thread_settings_applied` | 384 | 3,233 | 14% | probably machinery |
   | `response_item/tool_search_output` | 25 | 24,784 | 96% | falls to `plain()` |
   | `event_msg/item_completed` | 47 | 6,059 | 68% | |
   | `task_started` / `task_complete` / `turn_aborted` | 1,303 | ~180 | 0% | small, but still JSON |

   Three are already **machinery**, so they cost only the raw view: `top/session_meta`
   (490 rows, 54,750 mean), `top/world_state` (246, 46,614), `top/turn_context`
   (1,312, 4,738).

   Recommended order: **`user_message`** (rendering a person's own words as a JSON blob
   is the worst kind on this list, and `message` is right there), then the image/MCP
   payloads, which are big but rare. `thread_settings_applied` is probably a machinery
   entry rather than a renderer.

   **`exec_command_end` is closed — do not reopen it without new evidence.** It looked
   like the obvious first target and is not, for two measured reasons.

   It is a **retired record type**. Across all 831 rollouts here: April 1,521 records in
   9 of 11 files, May 2,096 in 12 of 247, June 0 in 251, **July 0 in 322**. It was
   dropped from the harness around early May 2026, alongside `view_image_tool_call` and
   `thread_name_updated`. Ranking it high was an artifact of the sample — two of the six
   largest files are from May. No live session emits one.

   It is also a **complete duplicate**. Over every rollout containing one (9,003
   records, not just the six largest): **9,003 of 9,003 pair with a
   `function_call_output` by `call_id`, zero orphans** — the opposite of
   `patch_apply_end`, where 36% had no other home. The paired output is a strict
   superset in shape, wrapping the same bytes in a `Chunk ID / Wall time / Process
   exited with code N / Output:` header, and the panel already renders it as a proper
   `tool_result`. 7,079 (79%) are byte-contained outright; 580 carry no
   `aggregated_output` at all; the remaining 1,344 (15%) hold tail bytes the paired
   output lost to a **different middle-truncation point** (both sides carry
   `…N chars truncated…` markers), not information unique to the record.

   Worth knowing if it is ever revisited: 95 of 126 sampled sit **between** the
   `function_call` and its output, and the row renders as `system`, which flushes the
   segment — so on these transcripts it splits the tool cluster at 75% of shell calls.
   Left alone by decision on 2026-07-30: the type is dead, so the fix would only make
   April/May transcripts read better, and adding a deny-list entry on 79% containment is
   a weaker duplication claim than the 98.7% the `agent_message` rule was built on.

2. **Mode switch loses the viewer's place — deliberately deferred.** Switching remounts
   the feed and lands at the tail. Seeding at the viewer's position opens a **hole**
   between that window and the live tail, and the feed's event store has no way to
   represent a gap: rows either side would render as adjacent when they are not.
   `otherModeIndex` is already on the wire and tested for exactly this, so the
   translation half is done; what is missing is an anchored subscribe plus gap
   handling in the store.

3. **`<oai-mem-citation>` renders as part of the agent's words**, in both views. A
   machine block riding inside assistant prose. Found while pairing `agent_message`
   with its record — it is the 170-char difference in the 85 pairs that were not
   byte-identical.

4. **Never run against a live host.** Everything here is verified against real
   transcripts and the host-free fixture; **no part of this arc has run through the
   actual host + sidecar + panel stack.** Under AGENTS.md that is a checkpoint: state
   the command and wait for a go-ahead.

5. **Still open from the previous handover** (2026-07-11, now 19 days old): the
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
