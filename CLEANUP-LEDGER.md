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
| R34 | R | 20/1302 | `agent-feed/sidecar/src/input/tmuxComposer.ts` |
| R35 | R | 22/518 | `packages/AgentPanel/Web/src/features/desktop-viewer/DesktopViewerSurface.tsx` |
| R36 | R | 22/864 | `packages/AgentPanel/Web/src/features/terminal/useAgentTerminal.ts` |
| R37 | R | 23/814 | `agent-feed/sidecar/src/terminal/agentTerminalService.ts` |
| R38 | R | 26/1087 | `packages/AgentPanel/Web/src/features/activity-feed/data-source/SidecarDataSource.ts` |
| R39 | R | 26/585 | `agent-feed/sidecar/src/config.ts` |
| R40 | R | 31/1834 | `agent-feed/sidecar/src/http/webrtcTileRoutes.ts` |
| R41 | R | 38/1157 | `packages/AgentPanel/Web/src/features/bots/BotCanvas.tsx` |
| R42 | R | 77/1211 | `packages/AgentPanel/Web/src/app/AgentPanelApp.tsx` |
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
