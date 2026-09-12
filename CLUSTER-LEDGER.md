# Cluster ledger

Bringing every directory in the two live TypeScript trees under the twelve-file ceiling stated in
`AGENTS.md`, "How long a file gets, and how flat a directory gets". The 500-line cap landed first
and produced its own failure: files that are each one idea, in directories that are a pile. This
ledger is the schedule for fixing that, and the record of the decisions taken on the way.

The rule, in four lines:

- Twelve source files per directory is the ceiling. A test rides with its source and is not
  counted separately.
- Three source files is the floor for a new directory. One or two of their own is a worse index
  than none.
- One clustering level below a feature. Promote a sibling rather than deepen; a second level needs
  its reason written here.
- Only fan-out promotes a cluster. Past twelve AND three or more files about the same thing.
  Counts earn directories, opinions do not.

Nothing changes but import lines. No file is split, merged, renamed, or edited for any other
reason. `features/desktop-viewer` is the worked example: 53 files, now 5 with seven directories
beside it (`79f79128`).

Measured on `79f79128`, `source files (all files) path`, worst first. That is the task order.

| Task | Directory | Source (all) | State |
|---|---|---|---|
| R1 | `agent-feed/sidecar/src/http` | 36 (62) -> 10 (18) | D |
| R2 | `packages/AgentPanel/Web/src/features/activity-feed` | 26 (44) -> 7 (13) | D |
| R3 | `packages/AgentPanel/Web/src/app` | 24 (50) -> 10 (32) | D |
| R4 | `packages/AgentPanel/Web/src/features/bots` | 20 (23) -> 7 (9) | D |
| R5 | `agent-feed/sidecar/src/transcripts` | 17 (23) | R |
| R6 | `agent-feed/sidecar/src/terminal` | 16 (24) | R |
| R7 | `agent-feed/sidecar/src/transcripts/sources` | 15 (21) | R |
| R8 | `packages/AgentPanel/Web/src/features/terminal` | 13 (18) | R |
| R9 | `packages/AgentPanel/Web/src/features/session-view` | 13 (13) | R |
| R10 | The gate: fitness check 7, the pre-commit hook, this file's summary | | R |

Re-measured after every task, because moving files out of a parent changes the parent's count:

```
for d in $(find packages/AgentPanel/Web/src agent-feed/sidecar/src -type d); do
  s=$(find "$d" -maxdepth 1 -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.*' | wc -l | tr -d ' ')
  [ "$s" -gt 12 ] && echo "$s $d"
done | sort -rn
```

## Groups

Written before anything moves, one line per group with its count. A group under three is dropped
and stays flat.

### R1 `agent-feed/sidecar/src/http`, 36 source files

Twenty of the thirty-six are not routes at all. They are the WebRTC tile stream, which landed here
because its one route did and then grew twenty files deep. It is one subject and it is over the
ceiling by itself, so it becomes five siblings rather than one directory:

- `tile-codec/` (4) the byte formats between the encoder's Annex-B output and an RTP track: the NAL
  splitter, the two packetizers that use it, and the codec the two ends negotiate. `annexB`,
  `h264Packetizer`, `h265Packetizer`, `webrtcTileCodec`.
- `tile-encoder/` (5) the grid-encoder children: the pool that is the only place a capture starts,
  which running encoder a request belongs to, what display it is pointed at, the stdout framing it
  writes, and the source metadata it reports. `webrtcEncoderPool`, `webrtcEncoderIdentity`,
  `webrtcDisplayTarget`, `encoderFrames`, `webrtcTileMetadata`.
- `tile-peer/` (4) one peer for one capture: the route, the offer-in-answer-out sequence, the clamp
  on everything a browser sent, and the one question about whether the peer is gone for good.
  `webrtcTileRoutes`, `webrtcTileAnswer`, `webrtcTileOffer`, `webrtcConnectionState`.
- `tile-control/` (4) the data channel that drives the Mac: who owns input across every peer, what a
  viewer may send while they do, and the events sent back. `webrtcTileControl`,
  `webrtcDesktopControl`, `webrtcDesktopControlEvents`, `webrtcDesktopControlOwnership`.
- `tile-diagnostics/` (3) whether anything is actually arriving, and how a person reads that back:
  the log every layer writes to, the correlation of what the viewer received against what the
  sidecar sent, and the census behind `just webrtc-sessions`. `webrtcDiagnosticsLog`,
  `webrtcConnectionDiagnostics`, `webrtcSessions`.

That leaves sixteen routes, still over. The cut the tree already documents: `parkRoutes` and
`usageRoutes` both say in their own first lines that they are NOT under `/api/sessions/` because
they are facts about the machine rather than about a thread. So the six that answer for one thread
move out and the machine-level ones stay:

- `session-routes/` (6) one thread, read and driven: its transcript and title, the composite
  subscription that opens it, a turn digested on demand, its background tasks, and the two ways text
  gets into the CLI running it. `sessionRoutes`, `timelineRoutes`, `summaryRoutes`, `taskRoutes`,
  `tmuxComposerRoutes`, `cliInputRoutes`.

`http/` keeps 10: the route table's own two (`route`, `httpResponses`) and the eight routes that
answer for the machine (`agentRoutes`, `botRoutes`, `inventoryRoutes`, `parkRoutes`, `usageRoutes`,
`windowRoutes`, `agentTerminalRoutes`, `tmuxRoutes`).

### R2 `packages/AgentPanel/Web/src/features/activity-feed`, 26 source files

Already three deep in siblings -- `data-source/` (12, at the ceiling), `markdown/` (6),
`transport/` (3) -- so this is the same level again, not a new one:

- `blocks/` (6) one event, drawn: the chip at its head, the views for each block kind, the system
  and raw drawers, the diff, the row that assembles them, and the client-side letter-by-letter
  reveal. `ActivityEventHeading`, `ActivityBlockViews`, `ActivitySystemBlocks`, `ActivityEventRows`,
  `DiffBlock`, `streamingText`.
- `rows/` (4) what the stream becomes before anything is drawn: normalised events folded into
  display items, the run of tool calls collapsed into one, the line a collapsed row previews, and
  which rows a window of events has. `activityDisplayItems`, `activityEventText`,
  `activityFeedLayout`, `useFeedRows`.
- `scroll-position/` (3) where the transcript is scrolled: following the tail, writing down where a
  session was left, and putting the reader back there. `useStickToBottom`, `transcriptScrollStore`,
  `useTranscriptScrollRestore`.
- `sticky-headers/` (3) the two bars pinned over the top: which to pin, which transcript line is at
  the top, and the component that draws them. `activityStickyHeaders`, `useStickyIndices`,
  `ActivityFeedStickyHeaders`.
- `reading-preferences/` (3) three things a reader sets and expects back: the font size, the view a
  thread opens in, and whether prompt-cache badges show. All three say in their own comments that
  they change what a row renders and never what the transcript is. `fontStore`, `eventModeStore`,
  `cacheHitStore`.

The feature keeps 7: the feed itself and its controls, the row it virtualises, the stream it reads,
the usage it folds out of that stream, the meter that shows it, and `activityNormalization`.

`TokenMeter` has no caller inside this feature -- all three are in `features/session-view` -- so
callers would send it out of the feature entirely. Out of scope: this task moves files within a
directory, never between features. Left flat, noted in Deferred.

`activityNormalization` has no callers at all, only its own test and a mention in the data source's
contract fixture. With nothing to follow it stays beside the type it builds, which is in
`useSessionEventsStream`, flat.

### R3 `packages/AgentPanel/Web/src/app`, 24 source files

- `shell-state/` (7) one hook per thing the App shell holds, plus the record of everything all
  three renderings of the sidebar are handed. Every one of the seven is imported by
  `AgentPanelApp.tsx`, `sidebarProps.ts`, or both, and by nothing else. `sidebarProps`,
  `useSidebarChrome`, `useThreadSelection`, `useBotCommands`, `useCanvasRoster`,
  `usePiSessionCreation`, `useProjectInventory`.
- `page/` (4) the page rather than the app: which surface this page is, its visibility lifecycle,
  the soft keyboard's inset, and which regions drag the native window. All four are `main.tsx`
  imports and nothing else reads them. `panelEntry`, `pageLifecycle`, `keyboardInset`, `windowDrag`.
- `fake-sidecar/` (3) the fake sidecar the panel runs against with no host and no agent: its entry,
  its routing table, and the projects, sessions and transcript lines it answers with. `fixture`,
  `fixtureRoutes`, `fixtureData`. Named for what it is rather than `fixture/`, because this
  repository already uses "fixture" for the wire contract document that neither end owns.

`app/` keeps 10: the shell and its dialogs, the surface switch, the entry point, the
AskUserQuestion view, the two dev-server modules, and the App-shell test scaffolding.

`testSetup.ts` and `sidecarBoard.ts` are named by path from outside `src` -- `vitest.config.ts`
`setupFiles` and a relative import in `vite.config.ts`. Both stay flat: `app/` is already under the
ceiling without them, and moving a file to make a config edit necessary is the opposite of the
point.

`agentPanelAppHarness` and `agentPanelAppMocks` are test support that counts as source, which is
the counting rule biting rather than a group. They ride flat with `AgentPanelApp.tsx`, which is
what they harness.

### R4 `packages/AgentPanel/Web/src/features/bots`, 20 source files

- `dialogs/` (5) the four modals the shell opens over everything else, and what to call the session
  two of them are about to start. All four are imported by `app/AppDialogs.tsx` and by nothing else;
  `sessionTitles` is imported by two of the four and by nothing else. `BotCreatorDialog`,
  `BotSessionPickerDialog`, `ForkSessionDialog`, `SessionRenameDialog`, `sessionTitles`.
- `cards/` (5) one Bot on the canvas and what is inside it: the card, a session inside the card, the
  card that starts a new one, the widths all of them agree on, and the grips that size them.
  `BotCanvasCard`, `BotSessionCard`, `BotNewSessionCard`, `botCanvasCards`, `useCardResize`.
- `menus/` (3) the row menu and the two menus built on it. `RowMenu`, `BotCardMenu`,
  `SessionRowMenu`.

The feature keeps 7: the canvas, the sidebar panel, the roster hook, the two remembered facts
(card sizes and Bot colours), and the two gestures over the strip.

`useCardResize` reads like a gesture and went to `cards/` anyway: both its callers are card files.
The alternative was a `gestures/` directory holding it with `useMoveAlongStrip` and
`useRememberedCanvasScroll`, which is a real concept and the wrong one -- those two are gestures
over the CANVAS and are imported by `BotCanvas`, while this one is a grip on a card. Splitting them
that way would have put a file with a directory it shares a word with rather than a caller.

## Decisions

Forks taken, with the alternative not taken. The standing tiebreakers, both from the desktop
viewer: promote a sibling rather than nest, and when a file could sit in two places, put it with
its callers.

### `origin/dir-clustering` was replaced rather than continued

The remote branch already held a run at this: `c53375c1` a ledger, `5cf77225` the desktop-viewer
grouping, `30ced4e2` a fix to it. All three sit on `d75ccace`, which is BEFORE the import-alias
migration (`6a4d2182`), so that branch still writes `../../..` everywhere and its fitness gate has
no check 6. Its grouping is not lost: `79f79128` on `main` is the same work replayed on top of the
migration, and says so in its own message. The remote branch is a snapshot of a tree that no longer
exists, and rebasing onto it would have handed this branch 69 renames of files whose contents no
longer match anything -- a large conflict for nothing gained.

So this run restarts from `79f79128` and takes none of that branch's content. It keeps all of its
history: the stale tip `30ced4e2` is merged in with `-s ours`, which records it as an ancestor and
changes not one byte of the tree, so the push is an ordinary fast-forward and nothing on the remote
is discarded. The alternative was a force-push, which reaches the same tree by throwing the old
commits away; there is no reason to destroy history that costs nothing to carry. The second
alternative, a new branch name, loses nothing either but leaves two branches with one name's worth
of meaning and the wrong one on top.

### This branch is never rebased, it merges

`git rebase origin/main` was the brief's per-task first step. It cannot be, because the `-s ours`
merge above is in this branch's history: rebase linearises, so it tried to replay the retired
branch's three commits and stopped on a conflict in this file. `origin/main` is already an ancestor
here, so the honest step is to check that and merge only when it stops being true:

```
git fetch origin && git merge-base --is-ancestor origin/main HEAD || git merge --no-edit origin/main
```

### `mock.module` was a fourth specifier form nothing was checking

`sessionRoutes.test.ts` mocked the tmux composer as `mock.module("../input/tmuxComposer.ts", ...)`.
Check 6 of the fitness gate matches `import`, `export ... from`, `vi.mock` and `require`, and not
`mock.module`, so that one relative specifier survived the alias migration. Moving the file into
`session-routes/` re-pointed it at `src/http/input/`, which does not exist -- the mock silently
stopped applying and two rename tests failed against the real implementation.

Rewritten as `"@/input/tmuxComposer.ts"`, which Bun resolves (measured: the file's six tests pass).
It is the only one in either tree. The alternative was to re-count the `../` for the new depth,
which restores the test and leaves the trap armed for whoever moves the file next.

The gate should have caught this and did not, so R10 adds `mock\.module` to check 6's expression as
well. It stays green: there is now nothing for it to match.

### A source path can also be a plain string, and typecheck cannot see it

`app/typeRendering.test.ts` reads two components off disk by literal path -- it asserts a CSS rule
about their markup rather than importing them -- so moving them into `blocks/` broke it with an
ENOENT that `tsc` had no way to know about. This is the one breakage class the aliased-import rule
does not cover: the specifier is not a specifier, it is an argument to `readFileSync`.

There is no gate for it and this run is not inventing one; the sweep before each commit is cheap:

```
git grep -nE '"(\.\./)*src/(features|http|app|transcripts|terminal)/[A-Za-z]' \
  -- packages/AgentPanel/Web/src agent-feed/sidecar/src
```

Run against both trees it returns eight lines, six of them `styles.css` and `markdown.css`, neither
of which this arc moves. The test suite catches it too, which is why it is a note and not a task.

## Deferred

Things this arc found and deliberately did not do, because they are a different change.

- **`TokenMeter` lives in the wrong feature.** Its three callers are all in
  `features/session-view` (`SessionComposer`, `SessionComposerBand`, `SessionView`) and nothing in
  `features/activity-feed` imports it. Moving a file between features is a scope this arc does not
  have: it changes which feature owns a component, not how flat a directory is.
- **`activityNormalization` has no callers.** Only its own test, and a comment in the data source's
  contract fixture calling it "the normalization target". Either it is dead or the fixture test is
  meant to be reaching it. Someone should find out; a clustering pass is not the place.

