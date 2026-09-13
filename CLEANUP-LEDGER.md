# TypeScript cleanup ledger

One job, two trees, and nothing else:

- `packages/AgentPanel/Web/src/**`
- `agent-feed/sidecar/src/**`

Two outcomes: no `.ts`/`.tsx` file in either tree over 500 lines, and files clustered by
concept so a reader finds a thing where its idea lives. Behaviour does not change. This is a
move, not a rewrite: no route path, wire field, localStorage key, tmux pane name, CSS class,
exported prop or user-visible string moves with it. `agent-feed/wire/` is the contract both
ends compile against and is not reshaped here.

Baseline, taken on `367a32f6` before the first edit: `just check-legs` green, sidecar
**898 pass / 0 fail**, panel **75 files / 939 tests**.

Order is least-churned first. `main` moves under this branch constantly, so the hottest files
are split last, with the freshest rebase behind them. Re-derive the order with:

```
for f in $(find packages/AgentPanel/Web/src agent-feed/sidecar/src \( -name '*.ts' -o -name '*.tsx' \) | xargs wc -l | sort -rn | awk '$1>500 && $2!="total"{print $2}'); do echo "$(git log --since='6 weeks ago' --oneline -- "$f" | wc -l)	$(wc -l < "$f")	$f"; done | sort -n
```

Per file: rebase on `origin/main`, read it whole, write its concepts here BEFORE splitting,
split, `just check` (before committing, while the tree is still dirty -- on a clean tree it
prints `nothing changed ... Nothing to check` and exits 0, which is not a pass), commit by
pathspec with the ledger flip in the same commit, push to `origin/chore/ts-cleanup`.

## Tasks

Status: R = open, D = done. `churn / lines` as measured 2026-09-09.

| ID | Status | churn/lines | File |
|---|---|---|---|
| R1 | D | 3/542 | `packages/AgentPanel/Web/src/features/usage/UsageModal.tsx` |
| R2 | D | 3/726 | `agent-feed/sidecar/src/live/claudeLiveBackend.ts` |
| R3 | D | 3/816 | `agent-feed/sidecar/src/live/codexLiveBackend.ts` |
| R4 | D | 4/536 | `agent-feed/sidecar/src/http/webrtcTileRoutes.test.ts` |
| R5 | D | 4/928 | `agent-feed/sidecar/src/desktop/composerCoordinator.ts` |
| R6 | D | 5/515 | `packages/AgentPanel/Web/src/features/activity-feed/activityDisplayItems.ts` |
| R7 | D | 5/676 | `agent-feed/sidecar/src/bots/botRegistry.test.ts` |
| R8 | D | 6/861 | `agent-feed/sidecar/src/bots/botRegistry.ts` |
| R9 | D | 8/501 | `agent-feed/sidecar/src/terminal/tmuxAttachment.ts` |
| R10 | D | 8/514 | `packages/AgentPanel/Web/src/features/desktop-viewer/useDesktopKeyboard.test.tsx` |
| R11 | D | 8/515 | `packages/AgentPanel/Web/src/features/desktop-viewer/KeyboardDeck.tsx` |
| R12 | D | 8/646 | `agent-feed/sidecar/src/transcripts/eventIndex.ts` |
| R13 | D | 9/507 | `packages/AgentPanel/Web/src/features/desktop-park/DesktopParkModal.tsx` |
| R14 | D | 9/508 | `agent-feed/sidecar/src/tasks/processProbe.test.ts` |
| R15 | D | 9/556 | `agent-feed/sidecar/src/tasks/processProbe.ts` |
| R16 | D | 9/593 | `packages/AgentPanel/Web/src/features/activity-feed/ActivityFeedBlocks.test.tsx` |
| R17 | D | 9/629 | `agent-feed/sidecar/src/transcripts/sources/codexTranscript.ts` |
| R18 | D | 9/764 | `agent-feed/sidecar/src/transcripts/sources/claudeTranscript.ts` |
| R19 | D | 10/713 | `packages/AgentPanel/Web/src/features/cli-input/useTmuxComposer.test.tsx` |
| R20 | D | 11/586 | `packages/AgentPanel/Web/src/features/cli-input/useTmuxComposer.ts` |
| R21 | D | 12/568 | `packages/AgentPanel/Web/src/app/fixture.ts` |
| R22 | D | 12/906 | `packages/AgentPanel/Web/src/features/desktop-viewer/useDesktopKeyboard.ts` |
| R23 | D | 13/862 | `packages/AgentPanel/Web/src/features/desktop-viewer/TileViewport.test.tsx` |
| R24 | D | 14/701 | `agent-feed/sidecar/src/terminal/tmuxSessions.ts` |
| R25 | D | 15/938 | `agent-feed/sidecar/src/transcripts/transcriptCatalog.ts` |
| R26 | D | 16/1275 | `packages/AgentPanel/Web/src/features/desktop-viewer/TileStreamRtc.tsx` |
| R27 | D | 16/761 | `packages/AgentPanel/Web/src/features/activity-feed/ActivityEventRows.tsx` |
| R28 | D | 17/792 | `packages/AgentPanel/Web/src/features/activity-feed/ActivityFeed.tsx` |
| R29 | D | 19/1125 | `agent-feed/sidecar/src/input/tmuxComposer.test.ts` |
| R30 | D | 19/1312 | `packages/AgentPanel/Web/src/features/desktop-viewer/TileViewport.tsx` |
| R31 | D | 19/2216 | `packages/AgentPanel/Web/src/features/session-view/SessionView.tsx` |
| R32 | D | 19/571 | `packages/AgentPanel/Web/src/features/sidebar/AgentSidebar.tsx` |
| R33 | D | 19/596 | `agent-feed/sidecar/src/terminal/agentTerminalService.test.ts` |
| R34 | D | 20/1302 | `agent-feed/sidecar/src/input/tmuxComposer.ts` |
| R35 | D | 22/518 | `packages/AgentPanel/Web/src/features/desktop-viewer/DesktopViewerSurface.tsx` |
| R36 | D | 22/864 | `packages/AgentPanel/Web/src/features/terminal/useAgentTerminal.ts` |
| R37 | D | 23/814 | `agent-feed/sidecar/src/terminal/agentTerminalService.ts` |
| R38 | D | 26/1087 | `packages/AgentPanel/Web/src/features/activity-feed/data-source/SidecarDataSource.ts` |
| R39 | D | 26/585 | `agent-feed/sidecar/src/config.ts` |
| R40 | D | 31/1834 | `agent-feed/sidecar/src/http/webrtcTileRoutes.ts` |
| R41 | D | 38/1157 | `packages/AgentPanel/Web/src/features/bots/BotCanvas.tsx` |
| R42 | D | 77/1211 | `packages/AgentPanel/Web/src/app/AgentPanelApp.tsx` |
| R43 | R | 78/4342 | `packages/AgentPanel/Web/src/app/AgentPanelApp.test.tsx` |
| R44 | R | - | Sweep: re-run the churn command, split whatever the splits pushed over 500. |
| R45 | R | - | Add the 500-line cap to `tools/agent-feed-fitness.sh`, then write the summary at the top of this file. |

## Concepts found, per file

Written before each split, one line per concept.

### R1 `features/usage/UsageModal.tsx` (542)

- The dialog shell: `<dialog>` open/close/backdrop lifecycle, the header, the range buttons, the
  vendor tab row, and the switch between error, not-installed, no-records and the panel.
- One vendor's grid: range totals, quota, day readout, calendar, legend, coverage footer, and the
  screen-reader sentence for a single cell.
- Token figures: the fixed-column totals row and the one stacked label-over-number figure.
- The quota row and how fresh its reading is.
- The hovered day's readout: that week against the one before, and the per-model list.

Split into siblings inside `features/usage/`: `UsageVendorPanel.tsx`, `UsageDayDetail.tsx`,
`UsageFigures.tsx`, `UsageQuotaRow.tsx`. `UsageModal.tsx` stays the entry point that
`features/profile/ProfileRow.tsx` imports.

### R2 `live/claudeLiveBackend.ts` (726)

- The `AgentBackend` surface a read-only mirror can answer: describe, page, subscribe, usage, and
  the five calls that throw because this backend can never send.
- The observer subscription and its reconnect-with-backoff loop.
- Observed flows: which are Anthropic message streams, and what one buffers while its session id
  is still being fetched from the request body.
- One assistant message assembled from its stream events, and what its usage record says.
- Which sessions hold a live projection, and when one is let go.

Split into `claudeLiveFlows.ts`, `claudeLiveMessages.ts`, and `liveSessionRegistry.ts` (shared with
codex, see the decision below). `claudeLiveBackend.ts` keeps the backend surface, the observer
loop, and the ingest routing that owns flows. 726 to 423.

### R3 `live/codexLiveBackend.ts` (816)

- The `AgentBackend` surface, the observer subscription and its reconnect loop, and the ingest
  routing that owns flows.
- Which observed flows are codex response sockets, and which item rows one has mid-stream.
- The assistant rows a turn is building, keyed by codex's own item id, and the user rows a
  `response.create` carries.
- What one websocket message does to those rows, and what a completed response reports about
  tokens and cache hits.
- Which sessions hold a live projection -- the same concept the claude mirror has.

Split into `codexLiveFlows.ts`, `codexLiveItems.ts`, `codexLiveEvents.ts`, and onto the shared
`liveSessionRegistry.ts` R2 introduced. 816 to 357. Two files where claude needed one, because
codex's rows are a stateful store (`items`, `lastContent`) and claude's message is a plain value
the flow already holds.

### R4 `http/webrtcTileRoutes.test.ts` (536)

- The routes themselves: what the telemetry endpoint's phase allowlist accepts and refuses, and
  what the sessions listing and close answer.
- Delivery: werift's RTP repair history, and correlating sender writes against selected-pair
  delivery and receiver backlog.
- The encoder: its control channel, PLI requests against emitted keyframes, when a peer state is
  terminal, and which capture stream an offer belongs to.

Split into `webrtcDelivery.test.ts` and `webrtcEncoder.test.ts`, with `webrtcTileRoutes.test.ts`
keeping the two describes that go through the route function. Every `describe` moved whole; test
count unchanged at 898.

### R5 `desktop/composerCoordinator.ts` (928)

- The vocabulary: a session key, a failure with a code the panel renders, a status worth telling a
  watcher about.
- Reaching a window: the one helper-verb wrapper, moving a window between Desktops, and running
  something with the window here before putting it back.
- Which window shows a session, per source -- two resolvers answering different questions.
- Borrowing a window for as long as a surface is watching, and giving it back.
- The backstop poll: what it re-resolves, what it may read for free, what each watcher is told.
- The coordinator itself: the surfaces asking for a write, serialized.

Split into `composerTypes.ts`, `composerWindowAccess.ts`, `composerTargets.ts`,
`composerLeases.ts`, `composerWatchPoll.ts`. 928 to 328. The maps and sets the poll shares with the
commands are handed over by reference, not copied, so both still agree about which pids are
observed and what each session last resolved to.

### R6 `activity-feed/activityDisplayItems.ts` (515)

- What a row in the feed is: the `DisplayItem` union, its accessors, its stable key, and the role
  an event renders as.
- Folding a run of tool calls into one row: which tools never fold, how short a run is not worth
  folding, and what a folded run calls itself.
- What one event says in a line: the collapsed preview, the intent the agent gave for its tool
  calls, and the command a shell tool ran.
- What the feed renders for a window of events: which rows exist, which tool results fold into the
  call that asked, and how one event's blocks split between body and Raw drawer.

Split into `activityEventText.ts` and `activityFeedLayout.ts`; the first two concepts stay in
`activityDisplayItems.ts`. `projectIncrementalReasoning` moved with `buildFeedLayout`, its only
caller.

### R7 `bots/botRegistry.test.ts` (676)

- The world a test runs in: a catalog of known projects and sessions, a temporary Bot directory,
  and a launcher that records rather than reaching for tmux.
- Adding a Bot, and attaching or detaching sessions it already has.
- Starting a session for a Bot: what the launcher is asked, what a replay answers, what a failure
  leaves behind.
- Adding sessions to a Bot that already has some: worktrees, labels, and forks.

Split into `botRegistryHarness.ts`, `botRegistryLaunch.test.ts` and
`botRegistrySessions.test.ts`. The harness is a function, not module state, so each file gets its
own catalog and its own `afterEach` -- the isolation one file had by being one file. The git
worktree helpers moved to the file whose tests use them. 898 sidecar tests, unchanged.

### R8 `bots/botRegistry.ts` (861)

- The vocabulary: who is asking, what the catalog answers, what can go wrong, what a launcher is.
- Turning a request off the wire into something actionable: every length limit and every field's
  normal form, all of it before anything is written.
- Answering a resent request with the Bot the first one made.
- Bringing a session into existence for a Bot, and recording it once it exists.
- The registry: what a command is allowed to do, and the snapshot a reader sees.

Split into `botTypes.ts`, `botCommands.ts`, `botIdempotency.ts`, `botSessionLaunch.ts`. 861 to
431. `BotSessionStarter` holds the registry's own store and catalog, handed over at construction,
so both halves write through one store.

### R9 `terminal/tmuxAttachment.ts` (501)

- One viewer's connection to a pane: envelopes out, bytes in, checkpoints.
- One shared pipe per tmux session, because a pane has exactly one pipe.
- Making a window the shape a viewer asked for, on a window every client shares.

Split into `tmuxPaneSize.ts`, which takes `SharedPane` with it: everything about the size is about
a resource that cannot be held twice, and every comment in it is a measurement. 501 to 356.

### R10 `desktop-viewer/useDesktopKeyboard.test.tsx` (514)

- The rendered hook and the DOM events jsdom will not produce: the capture textarea, the stand-in
  accessory, a driven paste, a driven beforeinput, a stood-up ResizeObserver.
- Arming: what a tap does before the Mac answers, what replaces a tap still waiting, which cursor
  shapes open a keyboard.
- Getting text in: clipboard, paste, dictation, composition, local echo, control keys.
- Knowing the keyboard is up, and how much of the screen it and its accessory cover.

Split into `useDesktopKeyboardHarness.tsx`, `useDesktopKeyboardText.test.tsx`,
`useDesktopKeyboardViewport.test.tsx`. 24 `it` blocks moved whole; 939 panel tests, unchanged, now
across 77 files.

### R11 `desktop-viewer/KeyboardDeck.tsx` (515)

- What a keycap looks like: the resting and pressed fills ported from the Swift, the shadows, the
  tint an armed shift wears, and the title size per key kind.
- What a press in flight is: which cell it owns, where the finger landed, whether it panned.
- Resolving a touch to a tiled cell, and what a commit does.
- The deck's own layout: rows, gaps, and the indent under Q and P.

Split into `KeyboardDeckKeycap.tsx`, holding `DeckKeycap` and the character balloon. The keycap was
already presentational -- the deck resolves touches to cells, not to elements -- so nothing about
hit testing moved with it. 515 to 408.

### R12 `transcripts/eventIndex.ts` (646)

- Shared bookkeeping: what a subscriber is told, how big a raw event may be, where a nice index
  lands a raw line, and the one place a session's index is dropped from.
- Building the index by scanning the file, deduping concurrent builds, and coping with truncation.
- Answering a reader out of a built index: counts, mode translation, usage, events, raw lines.
- Who is reading and for how long: the refcount, and one chokidar watch per file fanned out to
  every follower.

Split into `eventIndexState.ts`, `eventIndexBuild.ts`, `eventIndexReads.ts`. 646 to 179.

### R13 `desktop-park/DesktopParkModal.tsx` (507)

- The modal and its panel: the live tile, the plan, the footer of options.
- One window's row, what the last park or restore reported, and a button that can be busy.
- Windows grouped by the Desktop they are on now.

Split into `DesktopParkRows.tsx` and `desktopParkGroups.ts`; the test now takes `groupByDesktop`
from the module that holds it. 507 to 352.

### R14 `tasks/processProbe.test.ts` (508)

- What a session's open file descriptors say about the shells it is running (`lsof`).
- What `ps` says: its fixed columns, the wrapper a tool call runs behind, the descendant walk, and
  taking one snapshot per tick.

Split into `processTable.test.ts`. The two halves shared only `resetProcessTableCache`, and each
carries its own fixtures. 898 sidecar tests, unchanged.

### R15 `tasks/processProbe.ts` (556)

- Shelling out at all: the injected runner, and the two absolute binary paths.
- What `ps` says: one snapshot per tick, parsed into rows, walked for descendants, unwrapped out of
  the harness's shell wrapper.
- What `lsof` says: which shell holds which task's capture open, and where its output really goes.

Split into `commandRunner.ts` and `processTable.ts`, pairing with the `processTable.test.ts` R14
made. `processProbe.ts` stays the address thirteen callers already have. 556 to 214.

### R16 `activity-feed/ActivityFeedBlocks.test.tsx` (593)

- Rendering a complete block and its Raw drawer, which needs a data source and a render.
- Laying a window of events out, and partitioning one event's blocks.
- Reading one line out of an event: preview, flow kinds, shell command, tool intent.

Split into `activityFeedLayout.test.tsx` and `activityEventText.test.tsx`, so each of the three
modules R6 created now has its own suite at its own name. 939 panel tests, unchanged.

### R17 `transcripts/sources/codexTranscript.ts` (629)

- Where Codex keeps rollouts and its state database, and how to ask a rollout whether its last
  turn finished without reading all of it.
- What a rollout line's payload is: `response_item` against `event_msg`, the patch summaries, the
  labels each type wears on screen.
- Turning one line into the blocks a reader sees.
- The `SourceAdapter` itself, assembled from those three.

Split into `codexRollouts.ts`, `codexPayloads.ts`, `codexNormalize.ts`. 629 to 71.

### R18 `transcripts/sources/claudeTranscript.ts` (764)

- Claude's files on disk: where a transcript lives, what the catalog learns from its edges without
  reading it whole, and the sidecar file a large tool result was persisted to.
- What a line carries: the turn-boundary signal, the tool vocabulary its summaries are written in,
  the blocks a message's content becomes, and what its usage says about tokens and cache.
- Turning one line into the blocks a reader sees.
- The `SourceAdapter` itself.

Split into `claudeProjects.ts`, `claudePayloads.ts`, `claudeNormalize.ts`, the same four-way shape
R17 gave Codex. 764 to 74.

### R19 `cli-input/useTmuxComposer.test.tsx` (713)

- The mirrored pane a test runs against: the fake stream, the rendered probe, and the typing
  helpers every debounced push needs.
- Mirroring the box: what fills it, what pushes, what a reading may and may not overwrite.
- The command menu a pane is showing.
- The images a composer is holding, and the rail keys that go straight through.

Split into `useTmuxComposerHarness.tsx`, `useTmuxComposerCommands.test.tsx`,
`useTmuxComposerImages.test.tsx`. Three describes moved whole; 939 panel tests, unchanged.

### R20 `cli-input/useTmuxComposer.ts` (586)

- What a mirrored composer hands its surface: the controls, the state, the image tokens, and what
  to say when there is no composer to mirror.
- Keeping that true: the debounced push, the readings it may and may not adopt, the images it
  sends, the rail keys.

Split into `tmuxComposerHandle.ts`. 586 to 466 -- one file out, because the interface and its
seventy lines of doc are the contract, and the hook is one implementation of it.

### R21 `app/fixture.ts` (568)

- What the fake sidecar shows: the projects, the sessions, and one set of transcript lines
  projected into both modes.
- Which request path answers with what, and the live turn it dribbles out one frame at a time.
- Installing it as the page's message handler, before the transport is constructed.

Split into `fixtureData.ts` and `fixtureRoutes.ts`. 568 to 82.

### R22 `desktop-viewer/useDesktopKeyboard.ts` (906)

- What this reader chose, and the two storage keys that outlive one mounted surface.
- The keyboard's own state: which keyboard types, what the presentation reducer was told, and
  everything forgotten when it goes away.
- Putting input on the control channel: a key batch, a string, the draft a paste is edited in.
- The hidden capture field, and what the browser reports through it.
- What the Mac answers: whether the tap landed on editable text, and which keys it acknowledged.

Split into `desktopKeyboardPreferences.ts`, `desktopKeyboardContext.ts`,
`desktopKeyboardSession.ts`, `desktopKeyboardSend.ts`, `desktopKeyboardCapture.ts`,
`desktopKeyboardControl.ts`. 906 to 292.

### R23 `desktop-viewer/TileViewport.test.tsx` (862)

- The rendered surface and the browser pieces jsdom lacks: animation frames, a ResizeObserver,
  and MouseEvents standing in for PointerEvents.
- One finger on the tile: where the pointer goes, when a hold becomes a held button, what ends one.
- The scroll clutch and the puck: what stays local, what reaches the Mac as a wheel.
- The cursor the viewer sees, and correcting a prediction from the newest applied move.
- Zoom, pan, and the strip the keyboard leaves.

Split into `tileViewportHarness.tsx`, `tileViewportScroll.test.tsx`, `tileViewportCursor.test.tsx`,
`tileViewportZoom.test.tsx`. 29 `it` blocks moved whole; 939 panel tests, unchanged.

### R24 `terminal/tmuxSessions.ts` (701)

- Running tmux at all, and what it means when tmux is not there.
- What a pane is showing and has shown: scrollback, screen, cursor, and whether it has settled.
- Which sessions exist, which one is a given agent session, and how a new one is started.
- Driving a pane that already exists: bytes in, size, the pipe, the mouse option.

Split into `tmuxCommand.ts`, `tmuxCapture.ts`, `tmuxSessionList.ts`. 701 to 242.
`restoreTmuxMouse`'s doc comment, which had drifted a hundred lines above the function, moved back
onto it -- that is a comment travelling with the code it describes, not a rewrite of either.

### R25 `transcripts/transcriptCatalog.ts` (938)

- What the catalog holds, who is listening, and the coalesced broadcast that tells them.
- Turning a file on disk into a record, shared by all three sources.
- Finding Claude's sessions, which live in mangled per-project directories.
- Finding Codex's, which live in a SQLite database with rollout files beside it.
- Pi's, which this process started rather than discovered.
- The fold a reader is handed: project list, session summary, activity bin.
- The watchers, and starting and stopping the whole thing.

Split into `catalogState.ts`, `catalogRecords.ts`, `claudeCatalog.ts`, `codexCatalog.ts`,
`piCatalog.ts`, `catalogViews.ts`. 938 to 207. Each module-level timer moved to the concept that
sets it, and `stopCatalog` now asks each of them to stop rather than reaching into their variables:
`resetCatalogBroadcast` and `stopCodexReconcile` are that ask, and are the only declarations this
split added.

### R26 `desktop-viewer/TileStreamRtc.tsx` (1275)

- The wire: what the sidecar answers an offer with, what a viewer says when it leaves, one line of
  telemetry.
- How large a capture to ask for, given the box the picture is shown in.
- What the receiver's own statistics say, and one reading of them turned into telemetry.
- Whether frames are actually reaching the screen, which healthy statistics do not prove.
- The data channel input travels on.
- One attempt at a stream: offer, answer, media, and every way it can end.
- The component: the reconnect loop around those attempts, and the picture.

Split into `webrtcTileWire.ts`, `webrtcTileCapture.ts`, `webrtcReceiverStats.ts`,
`tileVideoPresentation.ts`, `tileReceiverStats.ts`, `tileControlChannel.ts`,
`tileStreamSession.ts`. 1275 to 373. The mutable slots one attempt writes for the next --
the retired peer, the attempt id a page teardown reports, the resolved display -- are handed to
`runTileSession` by reference as `TileSessionRuntime`, because they outlive an attempt on purpose.

### R27 `activity-feed/ActivityEventRows.tsx` (765)

- The chip at the head of an event: which role, whether collapsed, and the cache badge beside it.
- Which rows exist: user, segment event, live tail, cluster, compaction, and the shell they share.
- One block of an event, rendered, of every kind an adapter can emit.

Split into `ActivityEventHeading.tsx` and `ActivityBlockViews.tsx`. 765 to 374.
`app/typeRendering.test.ts` pins the prose leading by reading this file; it now reads both, because
the three text wrappers it counts moved with the blocks. The rule is unchanged, its subject grew.

### R28 `activity-feed/ActivityFeed.tsx` (841)

- Which rows the transcript has, and which of them are open -- one question, because
  clustering depends on what the reader expanded.
- Which bars to pin, and which transcript line is at the top of the viewport.
- Coming back to where a session was being read, and writing down where it is left.
- The thread's controls, portalled into the shell header.
- One virtualised row, whichever kind it turns out to be.
- The two pinned bars themselves.
- The feed: the scroll element, the virtualiser, and the empty states.

Split into `useFeedRows.ts`, `useStickyIndices.ts`, `useTranscriptScrollRestore.ts`,
`ActivityFeedControls.tsx`, `ActivityFeedRow.tsx`, `ActivityFeedStickyHeaders.tsx`. 841 to 414.
`activityStickyHeaders.ts` was deliberately left alone: its own header says the rules live there
without React so they can be tested with no virtualiser, so the hook that reads live geometry is a
separate file rather than an addition to it.

### R29 `input/tmuxComposer.test.ts` (1125)

- A pane screen built the way tmux would have drawn it, which every one of these tests reads a
  composer out of.
- Reading the box: where it is, what is in it, whether the reading is exact, and the command menu
  drawn under it.
- The keystrokes that turn what the box holds into what was typed.
- Pushing into a pane, and the two commands that are pastes rather than typing.
- Watching a pane, and the one-push-at-a-time rule two watchers share.

Split into `tmuxComposerHarness.ts`, `tmuxComposerKeys.test.ts`, `tmuxComposerRuntime.test.ts`,
`tmuxComposerWatch.test.ts`. 67 tests moved whole; 898 sidecar tests, unchanged.

### R30 `desktop-viewer/TileViewport.tsx` (1312)

- The numbers a gesture is tuned against, and where the puck's resting place is remembered.
- Everything one mount holds while a gesture is in flight -- the object the parts share.
- What a gesture reports: start, what the view did, how it ended.
- The marks a touch leaves while it decides what it is.
- Where the Mac's cursor is, as this viewer believes it.
- Scrolling: coalescing, momentum, and the wheel events that go to the Mac.
- What a pointer landing on the tile turns out to be.
- The puck, and its double-tap arbitration.
- The box the picture is shown in, and the one capture request a settled gesture may make.
- The two things drawn over the video that are not the video.

Split into `tileViewportConstants.ts`, `tileViewportRuntime.ts`, `tileViewportGestureTelemetry.ts`,
`tileViewportDragVisuals.ts`, `tileViewportCursorMirror.ts`, `tileViewportScrolling.ts`,
`tileViewportPointerHandlers.ts`, `tileViewportPuck.ts`, `tileViewportFrame.ts`,
`TileViewportOverlays.tsx`. 1312 to 449.

### R31 `session-view/SessionView.tsx` (2216)

- What the view knows about the terminal band beneath it.
- The view itself: the column, the feed, the summary, the terminal's height.
- The composer band: which surface owns composition for this session.
- What the field is in whichever band is showing, and what the caption under it says.
- Sending, and the action row that offers it.
- The band as it is drawn, once every question about which band it is has been answered.
- Mirroring a window's own composer, and mirroring Claude's AskUserQuestion panel.
- The terminal's affordances in the band, and an extension's prompt.
- A textarea that grows with its content.

Split into `sessionTerminalTypes.ts`, `SessionComposer.tsx`, `sessionComposerModel.ts`,
`sessionComposerEditor.ts`, `sessionComposerActions.tsx`, `SessionComposerBand.tsx`,
`useWindowComposer.ts`, `AskUserQuestionMirror.tsx`, `SessionExtensionUI.tsx`,
`SessionTerminalControls.tsx`, `useAutoGrowingTextArea.ts`. 2216 to 449 and 423.

### R32 `sidebar/AgentSidebar.tsx` (571)

- The sidebar and its dialog: which mode is showing, and the roster under it.
- One project row, and the sessions revealed under it in batches.
- The one-line rows shown instead of content: loading, empty, failed.

Split into `ProjectSidebarItem.tsx` and `SidebarStatusRows.tsx`. The batch sizes moved with the row
they describe, since how many sessions a project opens on is a fact about that row. 571 to 382.

### R33 `terminal/agentTerminalService.test.ts` (596)

- The fakes a test runs against: a recording PTY client, a recording tmux attachment, and the two
  ways a session resolves to a pane.
- Opening a terminal by resuming a CLI.
- Attaching a viewer to a tmux pane instead, and what a second viewer of that pane is owed.
- Which pane an agent session is running in: the stamp, the registry, and no tmux at all.

Split into `agentTerminalHarness.ts`, `agentTerminalTmux.test.ts`,
`agentTerminalSessionPane.test.ts`. 898 sidecar tests, unchanged.

### R34 `input/tmuxComposer.ts` (1302)

- Reading Claude's prompt box out of a pane's screen: where it is, what is in it, whether a faint
  row is a hint, and the command menu under it.
- Turning what the box holds into what was typed: nothing, an append, or a clear and a retype.
- The pane a session's composer is on, held while somebody watches, and one push at a time.
- What the composer functions need from tmux, and the watch that reports a box as it changes.
- The commands: sync, submit, accept, drop an image, rename.

Split into `composerBox.ts`, `composerKeystrokes.ts`, `tmuxComposerPanes.ts`,
`tmuxComposerRuntime.ts`. 1302 to 366. The module header's measurements stay on
`tmuxComposer.ts`, because they are what the whole module was built against rather than what any
one part does; `composerBox.ts` points at them.

### R35 `desktop-viewer/DesktopViewerSurface.tsx` (518)

- The surface: the dock, the navigation, and which streams are mounted.
- The two controls that are not the picture: the mode buttons and the resolution knob.
- The streams themselves, each subscribed below the viewport so a resolution change re-renders one
  of them rather than the view around them.

Split into `DesktopViewerControls.tsx` and `DesktopViewerStreams.tsx`. 518 to 361.

### R36 `terminal/useAgentTerminal.ts` (864)

- What a mounted terminal is, and what a caller may ask of it.
- How big the grid is, what a cell measures, and what colour the terminal is painted.
- What the sidecar's stream says and what it does to the screen.
- Making the type fit a box whose grid this side does not own.
- The mount itself: xterm, the subscription, the observers, the teardown.

Split into `agentTerminalTypes.ts`, `agentTerminalLayout.ts`, `agentTerminalRuntime.ts`,
`agentTerminalStream.ts`, `agentTerminalFit.ts`. 864 to 481. The four mutable facts both parts
touch -- the base cell, which side owns the pane shape, whether the far end closed, and the
subscription -- now live only on the runtime, not in the effect as well: two copies of those would
have diverged the first time either part wrote one.

### R37 `terminal/agentTerminalService.ts` (814)

- What a terminal request can be refused for, and the checks that refuse it.
- What a terminal is pointed at: which pane, which directory, which command, and whether a new
  one may be started at all.
- One PTY manager envelope, read as the one thing the wire says about a terminal.
- Reaching a live connection through whichever backend the target names, and the one error
  shape every way either can fail reads as.
- Owning the live terminals: the map, the shared stream, and the two backends bytes arrive on.

Split into `agentTerminalErrors.ts`, `agentTerminalIdentity.ts`, `terminalStreamMessages.ts`,
`agentTerminalBackends.ts`. 814 to 402. The `identify*` family were private methods reading three collaborators off `this`;
they are free functions over a `TerminalIdentityDeps` record now, and the class keeps a one-line
`identify` that hands them over, so `open` is untouched. `agentTerminalService.ts` stays the entry
point: ten files import it, and it re-exports the four errors, `liveTmuxSession`,
`AgentTerminalPtyClient` and `ResolvedAgentTerminalSession` so none of them had to move.

The first pass landed at 506 -- the delegating `identify` put back most of what the identity
module took out -- so `open`'s two branches went out as well, in a second commit. What is left
is what the service is actually for: the map of live terminals, the one stream every viewer
shares, and everything after "there is a connection".

### R39 `sidecar/config.ts` (585)

One concept that is merely long: a flat settings object nothing can be cut in half without
breaking a `config.x` somewhere. It split by layer instead.

- Reading one environment variable, and refusing the value rather than working around it.
- How many tokens a model's context holds, and how a model id finds its row.
- Where a binary this machine may not have actually is.
- The settings themselves, which is what is left.

Split into `configEnvironment.ts`, `contextWindows.ts`, `configBinaries.ts`. 585 to 459. The
object stays whole and stays in `config.ts`, so no reader of `config.something` moves.
`contextWindowFor` also stays, now one line over `contextWindowIn`: the prefix-matching rule
belongs beside the table it matches against, but the exported name reads `config.contextWindows`
and would have taken the file's own import back the other way.

### R38 `activity-feed/data-source/SidecarDataSource.ts` (1087)

- The transport every layer calls, and what a non-2xx answer means.
- Reading one session's thread: events, background tasks, and the prompts it raises.
- Typing at a session that is already running somewhere else, by three routes to one box.
- Opening a terminal, and everything said to one that is open.
- Every terminal viewer on one connection, dispatched by id.
- The inventory, the Bots, session commands, usage, config and the Desktop park.

Split into `sidecarRoutes.ts`, `SidecarTranscript.ts`, `SidecarComposers.ts`,
`SidecarTerminals.ts`, `sidecarTerminalStream.ts`. 1087 to 368. The class is still one class
with one API: each file is a layer extending the one below it, so every method body, signature
and doc comment moved verbatim and no call site changed. `sidecarTerminalStream.ts` is the
exception and is composed rather than inherited, because it is the only part with state of its
own to keep.

### R40 `sidecar/http/webrtcTileRoutes.ts` (1834)

- The diagnostics log, and the sender-side counters written to it.
- The pool of running grid-encoder children, one per capture stream.
- Which running encoder a request belongs to, and what to do about the one already there.
- What the viewer says about a connection, and what the sidecar knows about the same one.
- What an offer body is allowed to say, and the clamp that decides.
- Who owns input on this Mac, and what a viewer may send while it does.
- Building one peer for one capture: the offer in, the answer out.
- Who is watching and what is capturing, and the two ways either ends.
- The route table.

Split into `webrtcDiagnosticsLog.ts`, `webrtcEncoderPool.ts`, `webrtcEncoderIdentity.ts`,
`webrtcConnectionDiagnostics.ts`, `webrtcTileOffer.ts`, `webrtcTileControl.ts`,
`webrtcTileAnswer.ts`, `webrtcSessions.ts`, `webrtcConnectionState.ts`. 1834 to 128, and every
new file is under 470. `answer` is still one long function because it is a sequence whose every
step depends on the one before; what came out of it is the control channel, which is a closure
over five things that have to agree and had no reason to be inside it.

### R41 `bots/BotCanvas.tsx` (1157)

- What every part of the canvas agrees on: two widths, and what a failure names.
- Opening the canvas where the reader left it, and keeping saying where that is.
- Carrying one card along the strip and dropping it somewhere else in the order.
- One of a Bot's sessions, which is a whole session rather than a preview of one.
- One Bot on the canvas: its head, its roster, and the grips that size it.
- The surface itself: which Bots are on it, the order they are in, and the errors it carries.

Split into `botCanvasCards.ts`, `useRememberedCanvasScroll.ts`, `useMoveAlongStrip.ts`,
`BotSessionCard.tsx`, `BotCanvasCard.tsx`. 1157 to 387. The two widths and `sessionKey` came out
into their own file rather than staying in the surface, because a card reaching back into
`BotCanvas.tsx` for a number would be the cycle that makes the split unreadable.
`BotCanvas.tsx` stays the entry point and re-exports `BotCommandError`, which the app imports.

### R42 `app/AgentPanelApp.tsx` (1211)

One component of a thousand lines, holding six things that never change together.

- The sidebar's own arrangement: which view, how wide, and how it is revealed.
- The project and session inventory, and the one stream it all arrives on.
- What the reader arranged on the canvas: which Bots are on it, which sessions are open.
- Everything the shell asks a Bot to do, and the failures it reports back.
- Which thread is open, how it is read, and how it is reopened after a reload.
- Starting a fresh Pi session in a project, and what the sidebar says while it happens.
- The four dialogs the shell opens over everything else.
- Everything all three renderings of the sidebar are handed.

Split into `useSidebarChrome.ts`, `useProjectInventory.ts`, `useCanvasRoster.ts`,
`useBotCommands.ts`, `useThreadSelection.ts`, `usePiSessionCreation.ts`, `AppDialogs.tsx`,
`sidebarProps.ts`. 1211 to 487. Every comment in the original survives; the audit that checks
that is the one from the R31 decision, run over comment lines rather than all lines.

## Decisions

Forks taken, with the alternative not taken and why. At a fork, the option that changes less wins.

- **Merge `origin/main`, do not rebase onto it.** The plan said rebase, and rebasing after a push
  rewrites already-pushed history, which needs a force-push this session cannot make. Merging keeps
  every push a fast-forward and gets the same thing the rebase was for: the freshest `main` under
  the next split. The repo's own history already carries merges from `main` into topic branches.
  One duplicate of `f6bf6bb7` rode in on the rebase that had already happened; harmless, and the
  merge that follows sees the same change on both sides.
- **Branch is local `ts-cleanup`, pushes go to `origin/chore/ts-cleanup`.** The remote branch does
  not exist yet, so the first push creates it. Not renaming the local branch: renaming changes more
  than pushing to an explicit refspec does.

### Decision: the viewport's parts are staged onto one runtime object

Same shape as the keyboard, and for the same reason: a press, three moves and a release have to
agree about what is happening, and the agreement was one 960-line closure. `ViewportRuntime` is
that agreement, built once per mount; each part is a factory returning the functions it owns, and
they are `Object.assign`ed onto the runtime in turn.

Staged rather than constructed at once because the parts call each other -- a press asks the
gesture telemetry to open, the cursor mirror to warp and the scrolling to end. Every such call
happens at event time, by which point all of them are on the object.

### Decision: the keyboard's parts take a context object rather than closing over the state

Thirty-six `useCallback`s shared nineteen refs and eleven setters, so no group of them could move
without carrying the state with it. Every callback became a free function taking one
`KeyboardContext`, which the hook builds each render and hands over through a ref.

The alternative was leaving it whole, which is what "one concept, merely long" would have argued
for -- but it is not one concept: arming, sending, capturing and acknowledging are four, and each
now has an address. The cost is named honestly: every returned callback is now stable (deps `[]`)
where several used to change identity with `report`, so an effect listing one no longer re-runs
when `report` changes. Nothing in the panel passes an unstable `report`, and the 24 keyboard tests
cover the paths that would notice.

### Decision: the two transcript adapters are split the same way, but not shared

Claude and Codex now both read rollouts/projects, payloads, normalize, adapter. Unlike the live
backends in R2, nothing was merged: the two file layouts, envelopes and tool vocabularies have no
overlapping code, only an overlapping shape. Naming the parts alike is what makes that shape
visible; merging them would have invented a shared abstraction over two genuinely different wires.

### Decision: one shared session registry, not a copy per vendor

`claudeLiveBackend` and `codexLiveBackend` are near-identical twins for their whole session
residency half: `projectionFor`, `ensureProjection`, `touch`, `scheduleSessionDrop`,
`enforceSessionBound`, `dropSession`, `onSessionLive` and the subscriber counting differ only in
the vendor word in one error message, which idle-drop setting they read, and two extra maps codex
clears. Diffed before deciding.

The alternative was `claudeLiveSessions.ts` beside `codexLiveSessions.ts`: strictly smaller, since
it moves code without merging any, and it keeps the twins independent if they ever diverge. Not
taken, because it would have written the duplication into two new files whose names differ by one
word, which is the wreckage the clustering outcome exists to prevent. `LiveSessionRegistry` takes
the three differences as options (`vendor`, `idleDropMs`, `forget`), so no behaviour merged.

### Decision: `eventIndex.ts` keeps a facade, where `activityDisplayItems.ts` did not

The opposite call to R6, on purpose. The event index is refcounted: `acquireIndex` and
`releaseIndex` are what make a built index valid to read, so a caller reaching straight into
`eventIndexReads.ts` would be reading something it has not claimed. One address is the invariant,
not a convenience, so the entry re-exports and the two importers were left alone. R6 had no such
invariant -- `buildFeedLayout` is a pure function -- so a barrel there would only have hidden it.

### Decision: the four activity-feed importers were rewritten, not shielded by a re-export

Keeping `activityDisplayItems.ts` re-exporting the moved names would have changed nothing outside
the split, which is the smaller option. Not taken: a re-export leaves every reader still finding
`buildFeedLayout` at the old address, which is the clustering outcome undone by a barrel. The four
importers changed on their import lines only.

### Decision: composer parts are siblings in `desktop/`, not a `desktop/composer/`

Five files came out of one, which normally argues for a directory. Not taken: `desktop/` is already
eleven flat files, four of which (`controlHelper`, `rendererReviver`, `claudeSessionResolver`,
`codexSessionResolver`) are the coordinator's own collaborators and would have been left outside a
`composer/` that held only the new ones. Moving `composerCoordinator.ts` into a subdirectory would
also have changed the one import `http/windowRoutes.ts` makes of it, for no reader's benefit.

### Decision: siblings, not a subdirectory, inside `features/usage/`

Five files came out of one, which the plan would normally answer with a directory named for the
concept. `features/usage/` already IS that directory, and its six existing files are flat siblings.
A `features/usage/modal/` would have put the modal's parts one level deeper than `UsageCalendar.tsx`
and `usageGrid.ts`, which they sit beside and call. Flat changes less.

### Decision: a string-literal audit runs after every mechanical prefixing pass

The identifier-prefixing scripts these splits use guard comments and quote-adjacent tokens, but not
identifiers INSIDE a string. Three user-visible strings were rewritten that way in R31 -- "Send to
the terminal m.session", twice more -- and they typecheck cleanly, so nothing but reading catches
them. Every generated file is now swept for `m.`/`ctx.`/`deps.`/`live.` inside string literals
before the commit; the sweep is clean across all 36 generated files.

- R37 kept the three new modules as siblings in `terminal/` rather than a new directory, though
  three files came out of one. `terminal/` is already the concept directory and holds the tmux and
  PTY halves these read; a `terminal/identity/` under it would have named the same idea twice. The
  alternative was a directory per the three-file rule, not taken because the rule exists to stop a
  flat dumping ground and this directory is not one.
- R37 dropped `forkClaudeSessionCommand` from the import list. It was imported and never called, so
  the identity module took only `claudeSessionPaneName`, which is what it uses. Not a fix: rewriting
  the import list is part of the move, and carrying a name nothing reads into a new file would have
  been the larger change.

- R39 was taken before R38 and R40-R43. The churn recompute after R37 put `config.ts` lowest
  (21 commits in 30 days against `SidecarDataSource.ts`'s 26), where the original snapshot had
  it fourth. The brief's ordering rule is the recompute, not the snapshot.
- R39 left `contextWindowFor` in `config.ts` rather than moving it with its table. Moving it
  would have made `contextWindows.ts` import `config.ts` while `config.ts` imports it back for
  the environment override. The alternative -- passing the table at all four call sites -- was
  not taken because it changes three files that only want an answer for a model id.

- R38 split `SidecarDataSource` into a chain of base classes rather than a facade over composed
  objects. `AgentDataSource` requires five methods; the other forty-five are the concrete class's
  own API and every one has callers, so composition means forty-five delegating methods that say
  nothing and each of which separates a signature from the doc comment explaining it. Extending
  moves every line verbatim and changes no call site. The cost is a five-deep chain, which the
  header of `sidecarRoutes.ts` states rather than leaves to be discovered.
- R38 restored the four section banners (`// Transcript`, `// Extension UI`, `// Claude Desktop
  composer and AskUserQuestion panel`, `// Agent terminal`) into the files their sections landed
  in, rather than letting the file headers stand in for them. Two files hold more than one
  section, so the banners still divide something; `SidecarTerminals.ts` folded its banner's words
  into the file header instead.

- R40 named its parts as `webrtc*` siblings in `http/` rather than a `http/webrtc/` directory,
  though nine files came out of one. Nine `webrtc*` modules were already sitting beside it
  (`webrtcDisplayTarget`, `webrtcTileCodec`, `webrtcDesktopControl*`, the two packetizers), so a
  directory would have split one naming convention across two places. The alternative was moving
  those neighbours in as well, which is a change to files this task never opened.
- R40 gave `isTerminalWebrtcConnectionState` and `ATTEMPT_PATTERN` files of their own concept
  rather than leaving them in the route table that three of the new modules would then import
  from. A leaf importing the entry point back is the cycle that makes a split unreadable.

- R42 kept the five hook results as objects (`chrome.drawerOpen`, `commands.startFork`) rather
  than destructuring them back into seventy loose names. Destructuring cost about ninety lines of
  its own and would have left the file over the cap; more to the point, the prefix is what says
  which group a value belongs to at the point it is read. The mechanical prefixing pass skipped
  strings, comments and JSX attribute names, and the string-literal audit came back clean.
- R42 stopped at eight files rather than also extracting the render tree. `<main>` and the header
  read about twenty-five values each, so a component for either trades a block of JSX for a block
  of props that says nothing. The line count did not need it once the state groups were out.

## Deferred

Improvements noticed in passing and deliberately not made. This is not a bug-fixing arc.

- `CodexLiveBackend.dispose` never cleared its per-session `items` and `lastContent` maps, only
  the session drop paths did. Preserved exactly: `LiveSessionRegistry.clear` deliberately does not
  call `forget`, so dispose leaves those rows behind the way it always has.
- `CodexLiveBackend.acceptStreamEnded` takes a `ts` it does not use. Predates this arc.
- `postTileTelemetry`'s doc comment sits above `postWebrtcClose`'s in `webrtcTileWire.ts`, as it
  did in `TileStreamRtc.tsx`. Moved verbatim, detachment and all.
- In `activityEventText.ts`, `shellCommand`'s doc comment sits above `toolIntent`'s rather than
  above `shellCommand`. It was already detached in `activityDisplayItems.ts`; moved verbatim,
  detachment and all, rather than quietly re-homed.
