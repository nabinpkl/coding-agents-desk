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
| R9 | R | 8/501 | `agent-feed/sidecar/src/terminal/tmuxAttachment.ts` |
| R10 | R | 8/514 | `packages/AgentPanel/Web/src/features/desktop-viewer/useDesktopKeyboard.test.tsx` |
| R11 | R | 8/515 | `packages/AgentPanel/Web/src/features/desktop-viewer/KeyboardDeck.tsx` |
| R12 | R | 8/646 | `agent-feed/sidecar/src/transcripts/eventIndex.ts` |
| R13 | R | 9/507 | `packages/AgentPanel/Web/src/features/desktop-park/DesktopParkModal.tsx` |
| R14 | R | 9/508 | `agent-feed/sidecar/src/tasks/processProbe.test.ts` |
| R15 | R | 9/556 | `agent-feed/sidecar/src/tasks/processProbe.ts` |
| R16 | R | 9/593 | `packages/AgentPanel/Web/src/features/activity-feed/ActivityFeedBlocks.test.tsx` |
| R17 | R | 9/629 | `agent-feed/sidecar/src/transcripts/sources/codexTranscript.ts` |
| R18 | R | 9/764 | `agent-feed/sidecar/src/transcripts/sources/claudeTranscript.ts` |
| R19 | R | 10/713 | `packages/AgentPanel/Web/src/features/cli-input/useTmuxComposer.test.tsx` |
| R20 | R | 11/586 | `packages/AgentPanel/Web/src/features/cli-input/useTmuxComposer.ts` |
| R21 | R | 12/568 | `packages/AgentPanel/Web/src/app/fixture.ts` |
| R22 | R | 12/906 | `packages/AgentPanel/Web/src/features/desktop-viewer/useDesktopKeyboard.ts` |
| R23 | R | 13/862 | `packages/AgentPanel/Web/src/features/desktop-viewer/TileViewport.test.tsx` |
| R24 | R | 14/701 | `agent-feed/sidecar/src/terminal/tmuxSessions.ts` |
| R25 | R | 15/938 | `agent-feed/sidecar/src/transcripts/transcriptCatalog.ts` |
| R26 | R | 16/1275 | `packages/AgentPanel/Web/src/features/desktop-viewer/TileStreamRtc.tsx` |
| R27 | R | 16/761 | `packages/AgentPanel/Web/src/features/activity-feed/ActivityEventRows.tsx` |
| R28 | R | 17/792 | `packages/AgentPanel/Web/src/features/activity-feed/ActivityFeed.tsx` |
| R29 | R | 19/1125 | `agent-feed/sidecar/src/input/tmuxComposer.test.ts` |
| R30 | R | 19/1312 | `packages/AgentPanel/Web/src/features/desktop-viewer/TileViewport.tsx` |
| R31 | R | 19/2216 | `packages/AgentPanel/Web/src/features/session-view/SessionView.tsx` |
| R32 | R | 19/571 | `packages/AgentPanel/Web/src/features/sidebar/AgentSidebar.tsx` |
| R33 | R | 19/596 | `agent-feed/sidecar/src/terminal/agentTerminalService.test.ts` |
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

## Deferred

Improvements noticed in passing and deliberately not made. This is not a bug-fixing arc.

- `CodexLiveBackend.dispose` never cleared its per-session `items` and `lastContent` maps, only
  the session drop paths did. Preserved exactly: `LiveSessionRegistry.clear` deliberately does not
  call `forget`, so dispose leaves those rows behind the way it always has.
- `CodexLiveBackend.acceptStreamEnded` takes a `ts` it does not use. Predates this arc.
- In `activityEventText.ts`, `shellCommand`'s doc comment sits above `toolIntent`'s rather than
  above `shellCommand`. It was already detached in `activityDisplayItems.ts`; moved verbatim,
  detachment and all, rather than quietly re-homed.
