# Handover — 2026-07-30

Branch `main`, in sync with `origin/main`, nothing uncommitted from this arc.
(Previous handovers are preserved in this file's git history.)

**Gate**: full `just check` green (exit 0) — 654 host tests in 86 suites, 78 sidecar,
119 panel web. The other session's in-progress voice work that was failing `just check`
earlier in this arc has since landed.

**The one thing to do next**: nothing in this file has been seen on a running host.
Three separate arcs (Agents-window zoom, window restore, sidecar readiness + retry) are
verified only against tests and real transcripts. `just host-run` is a checkpoint under
AGENTS.md — state it, then wait for a go-ahead. The last time a live run happened it
immediately found a bug the tests had not (see *Window restore*).

Arcs after the two-views work below, newest first:

| commit | what |
|---|---|
| `9f380e92` | one readiness signal for both sidecars; voice waits too; the panel retries |
| `112b79f3` | wait for the agent-feed sidecar instead of racing it at launch |
| `6775caf8` | read what a Codex tool call actually did (`exec exec` → the command) |
| `f3282437` | stop a new stored field erasing every remembered window |
| `401fc220` | zoom the terminal too, and remember the level across a restart |
| `98cc2d3a` | zoom the Agents feed with `Cmd -` / `Cmd =` |
| `92cceef5` | close `exec_command_end` as dead and duplicated |
| `d2d0e806` | say which files a patch touched, not its whole payload |

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

- `sources/codexToolSummary.ts` — what a Codex tool row says it did. **The one place to
  change how a tool call is labelled**, for both argument shapes.

Panel, `packages/AgentPanel/Web/src/features/activity-feed/`:

- `activityDisplayItems.ts` — clustering, `leadEvent`, `itemKey`, `isSkillActivation`.
- `TokenMeter.tsx`, `eventModeStore.ts` — header readout, remembered mode.
- `ActivityFeed.tsx` — the feed; toggle and meter portal into the shell header.
- `app/AgentPanelApp.tsx` — the shell, and the projects/sessions subscribe-and-retry
  effect.

Host, `host/AgentDeskHost/`:

- `SidecarReadinessSignal.swift` — readiness for both sidecars. **The one place to
  change how a consumer waits.**
- `AgentFeedSidecarClient.swift` — the HTTP client; its `baseURLProvider` is async and
  stream URLs resolve inside the task.
- `AgentWindow/` — the Agents window: `AgentWindowZoom` (the chord and the step range),
  `AgentWindowContentView` (owns `performKeyEquivalent`), `AgentWindowRegistry`
  (lifecycle, debounced persistence, quit flush), `AgentWindowPresentationStore` (the
  on-disk frames, terminal attachment, and zoom level).

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

## Also shipped: the Agents window zooms, and remembers where it was

`Cmd -` / `Cmd =` / `Cmd 0` zoom the Agents window. The host is `LSUIElement`, so there
is no menu bar and no `NSMenuItem` key equivalent to hang this on; the chord is caught
in `AgentWindowContentView.performKeyEquivalent`. That view exists **because the window
is `AgentPanelWindow` normally and a plain `NSWindow` under `Config.axAutomationEnabled`**
— owning the key equivalent one level down covers both without branching.

Both halves move together: the feed webview takes `pageZoom`, the terminal pane takes a
**font size**, not page zoom — a terminal is laid out in character cells, so changing
the font reflows the grid where scaling the page only magnifies it
(`PtyTerminalWebView.defaultFontPointSize`, now shared with the Workspace IDE terminal
rather than a second `14` literal). The level persists in
`AgentWindowPresentationStore` beside the frame, on the same debounce, and
`beginStopAll` **flushes** pending writes before cancelling them — otherwise a zoom in
the last 200 ms before quit was silently dropped, which defeats the point.

Zoom survives quit-and-relaunch. It does **not** survive a user closing the window: a
user close deletes the stored placement by design, and `shuttingDown` is what tells the
two apart.

### Window restore: a lesson worth not repeating

Adding `zoomStep` to `AgentWindowPresentationDescriptor` as a required field silently
broke restore for **every** window. The store decodes the whole document as one value,
so one missing key threw `keyNotFound`, and `read`'s `try?` swallowed it and returned
`[]`. A live host run found it in one launch; the tests did not, because every test
wrote its own fixture with the new field present.

Two fixes, both worth keeping: `zoomStep` decodes through a hand-written initializer
with a default (matching `WorkspaceIDELocalState`'s precedent for the identically-named
field, which should have been followed the first time), and `read` now **logs** a decode
or oversize failure instead of returning `[]` in silence. There is a regression test
built from the real on-disk document.

Still open, not done: the store decodes all descriptors as one value, so a future bad
field still costs every window rather than one. Decoding them individually would bound
that.

## Also shipped: sidecars are waited for, and a failed subscription retries

The Agents window came up showing `Projects unavailable: agent feed is not ready` after
an ordinary host restart. Not flaky — a structural race, from the host log:

```
16:04:23.973  sidecar started                       baseURL = nil
16:04:24.200  Agents window restored, webview up    subscribes HERE
16:04:25.251  sidecar ready baseURL=…:7682          1.05s too late
```

Readiness was a plain `URL?` that callers sampled at the instant of a request. The
window asked one second early, got `SidecarClientError.notReady`, and — because
`AgentFeedBridge` calls `removeVisibilityStream` when a stream reports an error, and the
panel's subscribe effect depends only on `[bridge, nav]` — **nothing ever re-subscribed**.
One second of overlap cost the window its whole session.

Three changes:

- **`SidecarReadinessSignal`** (`host/AgentDeskHost/`) is now the single home for
  readiness, used by both the agent-feed and voice sidecars. `publish` wakes waiters;
  `clear` (unexpected exit) deliberately **leaves them waiting**, because the restart is
  what they want; `stop` (deliberate teardown) releases them. Both sidecars lost their
  own `baseURL` storage — it is a computed read through the signal now, which also fixes
  a pre-existing cross-thread read.
- **`HttpSidecarClient` takes an async provider** and resolves its URL *inside* the
  stream task. Opening a stream stays synchronous, so callers still get a cancellable
  handle immediately; arriving early costs the first snapshot latency instead of the
  subscription. Bounds live in `Config`: `agentFeedSidecarReadyWaitSeconds` = 10 (its
  supervisor allows 5s plus a 1s first restart), `voiceSidecarReadyWaitSeconds` = 20
  (that supervisor's own budget; longer would just be silence to someone holding a
  button). `VoiceLaneServer.BaseURLProvider` went async for the same reason — it was
  telling the phone "voice service unavailable" during launch.
- **The panel re-subscribes after a failure**, delay doubling 1s → 15s, reset on a good
  snapshot, with a `Retrying…` line under the error so it reads as a state and not a
  dead end. Waiting fixes the launch race; retry covers what waiting cannot — an outage
  longer than the wait, or a sidecar that dies while a window is open.

Watch out in `AgentPanelApp.tsx`: the consecutive-failure count is a **`useRef`**, not
state, and `retryNonce` only ever increments. Resetting a counter that sits in the
effect's own dependency array tears down the subscription that just succeeded and drops
the viewer back to "Loading". A test caught that; keep it.

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

4. **Never run against a live host — this is the top item.** Everything here is
   verified against real transcripts, unit tests, and the host-free fixture; **no part
   of these arcs has run through the actual host + sidecar + panel stack**, except one
   launch that immediately found the restore bug. Under AGENTS.md `just host-run` is a
   checkpoint: state the command and wait for a go-ahead. What a live run should
   confirm, in one pass:
   - both saved Agents windows come back at their remembered frames, on their desktops;
   - `Cmd -` / `=` / `0` scale the feed **and** the terminal pane's font together, and
     the level survives quit-and-relaunch;
   - the restored window populates from a cold start rather than showing
     `agent feed is not ready` (this is the whole point of the readiness change);
   - `pkill -f agent-feed-sidecar` mid-session makes the window show `Retrying…` and
     then recover on its own, without reopening it;
   - tool rows read as commands and file lists rather than `exec exec`.

5. **Residual work behind the readiness fix.** All small, none blocking:
   - `VoiceEngineSidecar.stop()` runs on a queue that `waitUntilReady` can block for up
     to 20s, so its waiter release can be delayed where the agent feed's `queue.sync`
     one is prompt. Making both `sync` would even that out.
   - `AgentWindowPresentationStore` still decodes every descriptor as one value, so a
     future bad field costs all windows instead of one.
   - The **thread** layer has no retry; only the projects and sessions layers do. An
     `agent-thread-error` sets `connected = false` in `useSessionEventsStream` and stops
     there. `BridgeDataSource.resumeAfterSessionReconnect` does re-subscribe threads,
     but it fires on a QUIC session reconnect, not on a sidecar error — so a sidecar
     restart while a thread is open still needs a manual back-and-forward.

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
- **A new required field in a persisted struct erases the whole store.** Swift's
  synthesized decode throws `keyNotFound`, `AgentWindowPresentationStore` decodes the
  document as one value, and its `read` used `try?`. Adding `zoomStep` silently stopped
  every Agents window from restoring, and only a live launch found it. Give a new field
  a defaulted decode, and never let a store swallow a decode failure — it now logs.
- **Readiness is an event, not a value to sample.** `SidecarReadinessSignal` is the one
  home for it. When adding a consumer, await it; do not read `baseURL` and branch on
  nil, which is the bug that cost the Agents window a whole session.
- **A subscription that reports an error is torn down host-side.** `AgentFeedBridge`
  removes the stream, so any caller that wants to survive a failure has to re-subscribe
  itself. The projects and sessions layers do; the thread layer still does not.
- Device and host launches are a checkpoint (AGENTS.md): prepare, state the command,
  then wait for "run it".
