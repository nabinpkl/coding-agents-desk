# Cluster ledger (archived)

> Retired 2026-09-09, the day its branch merged as `e5adc32a`. All 10 tasks are D, and the ceiling
> is gated: check 7 of `tools/agent-feed-fitness.sh` fails a directory holding more than twelve
> source files, and `tools/git-hooks/pre-commit` asks the same at commit time. No ID travels
> forward.
>
> The five entries under `## Deferred` are not tasks and carry no IDs, but two of them are real
> questions someone should answer rather than inherit: `TokenMeter` sits in `features/activity-feed`
> while all three of the components that render it are in `features/session-view` (one test in its
> own feature renders it too, which is the part the entry below leaves out), and
> `activityNormalization` has no caller but its own test, the contract fixture naming it only in a
> comment. Both are a different change than flattening a directory, which is why
> they were left. The other three are load-shaped test timeouts, three directories one file short
> of the next task, and a source path written as a plain string that typecheck cannot see.
>
> The rule this arc produced lives in `AGENTS.md` under "How long a file gets, and how flat a
> directory gets", together with why twelve and why three. This file is the record of which
> directory became which, kept whole because each table row is the reason a move was a move.

## Done

Every directory in both live TypeScript trees is at twelve source files or under, and the ceiling
is now gated. Nine directories were over on `a6335e5c`; the worst held 36. Nothing changed but
import lines: no file was split, merged, renamed, or edited for any other reason, and no route
path, wire field, storage key, CSS class or exported prop moved.

Twenty-two new directories, each earned by a count rather than by a concept:

| Directory | Source files | What it holds |
|---|---|---|
| `sidecar/http/tile-codec/` | 4 | The byte formats between the encoder's Annex-B output and an RTP track: the NAL splitter, the two packetizers, the negotiated codec. |
| `sidecar/http/tile-encoder/` | 5 | The grid-encoder children: the pool that is the only place a capture starts, which encoder a request belongs to, its display, its stdout framing, its metadata. |
| `sidecar/http/tile-peer/` | 4 | One peer for one capture: the route, offer in and answer out, the clamp on everything a browser sent, whether the peer is gone for good. |
| `sidecar/http/tile-control/` | 4 | The data channel that drives the Mac: who owns input across every peer, what a viewer may send, the events sent back. |
| `sidecar/http/tile-diagnostics/` | 3 | Whether anything is arriving: the log every layer writes to, the sender/receiver correlation, the census behind `just webrtc-sessions`. |
| `sidecar/http/session-routes/` | 6 | One thread, read and driven: its transcript and title, the subscription that opens it, a digested turn, its tasks, the two ways text reaches its CLI. |
| `sidecar/transcripts/catalog/` | 8 | The catalog of every session this machine can show, its three per-vendor finders, and the watchers that keep it true. |
| `sidecar/transcripts/event-index/` | 4 | Who is reading a transcript, for how long, and what they are told as it grows. |
| `sidecar/transcripts/claude/` | 5 | Everything Claude-specific about reading a transcript line. |
| `sidecar/transcripts/codex/` | 6 | The same for Codex, plus what a tool call row says it did. |
| `sidecar/terminal/tmux/` | 7 | Attaching with tmux's own primitives instead of through the PTY manager. |
| `sidecar/terminal/pty/` | 3 | Talking to the PTY manager: the client, the protocol, one envelope. |
| `panel/app/shell-state/` | 7 | One hook per thing the App shell holds, plus what all three renderings of the sidebar are handed. |
| `panel/app/page/` | 4 | The page rather than the app: which surface it is, its lifecycle, the keyboard inset, the native drag regions. |
| `panel/app/fake-sidecar/` | 3 | The fake sidecar the panel runs against with no host and no agent. |
| `panel/activity-feed/blocks/` | 6 | One event, drawn. |
| `panel/activity-feed/rows/` | 4 | What the stream becomes before anything is drawn. |
| `panel/activity-feed/scroll-position/` | 3 | Following the tail, and coming back where a session was left. |
| `panel/activity-feed/sticky-headers/` | 3 | The two bars pinned over the top of the transcript. |
| `panel/activity-feed/reading-preferences/` | 3 | Font size, the view a thread opens in, whether cache badges show. |
| `panel/bots/dialogs/` | 5 | The four modals `AppDialogs` opens, and what to call the session two of them start. |
| `panel/bots/cards/` | 5 | One Bot on the canvas, a session inside it, the new-session card, their widths, the grips that size them. |
| `panel/bots/menus/` | 3 | The row menu and the two built on it. |
| `panel/terminal/mounted-terminal/` | 6 | What one mounted terminal is and holds, which is what `useAgentTerminal` assembles. |
| `panel/session-view/composer/` | 8 | The band under the transcript and everything that composes into it. |

One directory was removed: `sidecar/transcripts/sources/`. Its four remaining files were the seam
between the two vendors rather than sources, so they moved up to `transcripts/`. R7 has the
reasoning and the two alternatives.

The gate landed last, green the day it landed:

- **Check 7 in `tools/agent-feed-fitness.sh`** fails when a directory in either tree holds more
  than twelve source files, naming each one and its count.
- **`tools/git-hooks/pre-commit`** asks the same question of the directories a commit touches,
  counted out of the index so it measures what will land rather than what the worktree happens to
  hold.
- **Check 6 gained `mock.module`**, a fourth specifier form nothing was checking. It cost two
  silently-broken tests during R1.

The three-file floor is deliberately NOT gated. `AGENTS.md` was amended during this arc
(`80315310`) to say why: it governs the moment you are splitting, and says nothing about a
directory that is simply small. Five directories are under three and all five are correct --
`screen-viewer` is a whole surface that is one file, `src/types` is shared types.

Everything below is the working record: the groups as written before each move, the decisions taken
at each fork, and what was found and left alone.

---

Bringing every directory in the two live TypeScript trees under the twelve-file ceiling stated in
`AGENTS.md`, "How long a file gets, and how flat a directory gets". The 500-line cap landed first
and produced its own failure: files that are each one idea, in directories that are a pile. This
ledger is the schedule for fixing that, and the record of the decisions taken on the way.

The rule, in four lines:

- Twelve source files per directory is the ceiling. A test rides with its source and is not
  counted separately.
- Three source files is the floor when you are SPLITTING: a group of one or two is not a cluster,
  so those files stay flat. It is not a property every directory must satisfy, and it is not gated.
- One clustering level below a feature. Promote a sibling rather than deepen; a second level needs
  its reason written here.
- Only fan-out promotes a cluster. Past twelve AND three or more files about the same thing.
  Counts earn directories, opinions do not.

Nothing changes but import lines. No file is split, merged, renamed, or edited for any other
reason. `features/desktop-viewer` is the worked example: 53 files, now 5 with seven directories
beside it (`a6335e5c`).

Measured on `a6335e5c`, `source files (all files) path`, worst first. That is the task order.

| Task | Directory | Source (all) | State |
|---|---|---|---|
| R1 | `agent-feed/sidecar/src/http` | 36 (62) -> 10 (18) | D |
| R2 | `packages/AgentPanel/Web/src/features/activity-feed` | 26 (44) -> 7 (13) | D |
| R3 | `packages/AgentPanel/Web/src/app` | 24 (50) -> 10 (32) | D |
| R4 | `packages/AgentPanel/Web/src/features/bots` | 20 (23) -> 7 (9) | D |
| R5 | `agent-feed/sidecar/src/transcripts` | 17 (23) -> 5 (7) | D |
| R6 | `agent-feed/sidecar/src/terminal` | 16 (24) -> 6 (10) | D |
| R7 | `agent-feed/sidecar/src/transcripts/sources` | 15 (21) -> dissolved | D |
| R8 | `packages/AgentPanel/Web/src/features/terminal` | 13 (18) -> 7 (10) | D |
| R9 | `packages/AgentPanel/Web/src/features/session-view` | 13 (13) -> 5 (5) | D |
| R10 | The gate: fitness check 7, the pre-commit hook, this file's summary | | D |

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

### R5 `agent-feed/sidecar/src/transcripts`, 17 source files

The import graph decides both groups outright; neither needed a judgement call.

- `catalog/` (8) the catalog of every session this machine can show, and the watchers that keep it
  true. `claudeCatalog`, `codexCatalog` and `piCatalog` are each imported by `transcriptCatalog` and
  by nothing else in either tree; `catalogRecords` and `catalogState` are imported by those three
  plus `transcriptCatalog` and `catalogViews`, and by nothing else; `watchTree`'s only caller is
  `transcriptCatalog`, whose own first line already names the watchers as part of the catalog.
- `event-index/` (4) who is reading a transcript, for how long, and what they are told as it grows:
  the reader-facing half, the build that turns a file into an index, the reads that answer out of
  one, and the bookkeeping the other three share -- which `eventIndexState` says of itself.
  `eventIndex`, `eventIndexBuild`, `eventIndexReads`, `eventIndexState`.

`transcripts/` keeps 5: which events a person wrote, the rename, what counts as a title, the state
every layer holds, and the usage fold.

The three vendor catalog files stay with the catalog rather than joining their vendor's parsing in
R7. That is the callers rule and it is also the layer the code is built on: `transcriptCatalog`
dispatches by vendor to find sessions, `sources/sourceAdapters` dispatches by vendor to read their
lines, and those two dispatches are separate on purpose.

### R6 `agent-feed/sidecar/src/terminal`, 16 source files

`agentTerminalBackends` says its own job in its first line: reaching a live connection through
whichever backend its target names. There are two backends, and each is a group.

- `tmux/` (7) attaching with tmux's own primitives rather than through the PTY manager: the
  attachment, what a pane is showing and has shown, running tmux at all, making a window the shape
  a viewer asked for, which sessions exist, the multiplexer's session list, and the name a title
  becomes. `tmuxAttachment`, `tmuxCapture`, `tmuxCommand`, `tmuxPaneSize`, `tmuxSessionList`,
  `tmuxSessions`, `tmuxSessionNames`.
- `pty/` (3) talking to the PTY manager: the client, the protocol both of them and tmux read, and
  one envelope read as the one thing the wire says about a terminal. `ptyClient`, `ptyProtocol`,
  `terminalStreamMessages`.

`terminal/` keeps 6: the service that opens, feeds and closes what a panel is watching, the backend
switch, what a terminal is pointed at, what a request can be refused for, the fakes its tests run
against, and starting a Claude session in a pane this sidecar owns.

`terminalStreamMessages` went to `pty/` against the callers rule: its one caller is
`agentTerminalService`, which stays flat. It is a PTY manager envelope, it imports `ptyProtocol`,
and it says both in its first line -- and the alternative leaves `pty/` at two, under the floor,
for a file that is unambiguously about the PTY manager.

### R7 `agent-feed/sidecar/src/transcripts/sources`, 15 source files

The only fan-out here is the vendor. Eleven of the fifteen are Claude's or Codex's and are imported
by that vendor's own files and nothing else; the other four are the seam between them.

- `transcripts/claude/` (5) everything Claude-specific: the adapter, one transcript line as the
  blocks a reader sees, what a line carries, where its files are on disk, and the text of one
  `thinking` block. `claudeTranscript`, `claudeNormalize`, `claudePayloads`, `claudeProjects`,
  `claudeThinking`.
- `transcripts/codex/` (6) the same for Codex, plus what a tool call row says it did and where the
  rollouts live. `codexTranscript`, `codexNormalize`, `codexPayloads`, `codexReasoning`,
  `codexRollouts`, `codexToolSummary`.

`sources/` does not survive. Its remaining four are the seam, not a source: `transcriptTypes` is
"the adapter seam" and is imported by roughly fifty files across the sidecar, `sourceAdapters` is
the fourteen-line registry that dispatches to the two adapters, and `lineClass` and `plainActivity`
are read by both vendors. They move up to `transcripts/`, which lands at 9.

Three ways to do this, and the third is the one taken.

1. **`sources/claude/` and `sources/codex/`**, a second clustering level. Rejected: `AGENTS.md`
   asks for a written reason and the reason would have been weak. The nesting is truthful -- a
   partition of a set by the axis the code already dispatches on -- but it buys nothing that (3)
   does not, and costs the reader a level.
2. **Promote the two vendors and leave `sources/` holding the other four.** This is the brief's
   stated preference and it is what was tried first. It leaves a directory called `sources` whose
   contents are not sources: the two adapters, which are the sources, would be outside it, and
   `sourceAdapters.ts` -- the registry pointing AT them -- would be inside. A name that has become
   a lie is worse than the extra level in (1).
3. **Promote the two vendors and dissolve `sources/` entirely.** One level everywhere, no
   misnamed directory, and `transcriptTypes` ends up at `@/transcripts/transcriptTypes`, which is
   what fifty importers across the sidecar are actually reaching for. It moves four more files than
   (2), which is the cost.

`claudeThinking` and `codexReasoning` each have a caller in `lineClass`, which stays flat, so the
callers rule splits rather than decides. Each went to its vendor: nothing else could be about the
text of one Claude `thinking` block.

### R8 `packages/AgentPanel/Web/src/features/terminal`, 13 source files

One group, and the import graph draws its boundary exactly: six files that `useAgentTerminal`
assembles, each imported only by that hook or by another of the six, and by nothing anywhere else
in either tree.

- `mounted-terminal/` (6) what one mounted terminal is and holds: what a caller may ask of it, how
  big its grid is and what colour it is painted, making the type fit a box whose grid this side
  does not own, how finely that type is sized, what it holds while its stream and its fit both read
  it, and what the sidecar's stream does to the screen. `agentTerminalTypes`, `agentTerminalLayout`,
  `agentTerminalFit`, `terminalTypeFit`, `agentTerminalRuntime`, `agentTerminalStream`.

The feature keeps 7: the hook itself, the pane, the key rail, the tile, the surface, one stable
string for what a terminal is pointed at, and which sessions type into their own terminal rather
than into the composer.

### R9 `packages/AgentPanel/Web/src/features/session-view`, 13 source files

- `composer/` (8) the band under the transcript and everything that composes into it: the band as
  it is drawn once every question about which band it is has been answered, what the field is in
  whichever band is showing, what the composer's parts read, sending and the action row that offers
  it, the textarea that grows, the mirror of a window's own composer, and Claude's AskUserQuestion
  panel mirrored. `SessionComposer`, `SessionComposerBand`, `sessionComposerEditor`,
  `sessionComposerModel`, `sessionComposerActions`, `useAutoGrowingTextArea`, `useWindowComposer`,
  `AskUserQuestionMirror`.

The feature keeps 5: the session view, the terminal band beneath it and what the view knows about
it, the extension prompt, and taking an image dropped on a session.

`SessionExtensionUI` says in its own first line that it is rendered inside the session band, and
its two callers are `SessionComposer` and `SessionView` -- one inside the group and one outside, so
the callers rule ties. It stays flat. The count was already earned at eight; a ninth file added on
a tie-break is the opinion the rule exists to keep out.

### R10 the gate

Last, so it is green the day it lands, and it is: both trees were already under the ceiling before
a line of it was written.

Check 7 counts with `find -maxdepth 1`, excluding `*.test.ts` and `*.test.tsx`, and names every
offender with its count. The pre-commit hook asks the same question but only of the directories the
commit touches -- that is the only place a commit can make things worse, and asking about the whole
tree would refuse a commit over somebody else's directory. It counts out of the INDEX, like the
line cap beside it, because a pathspec commit builds a temporary index holding exactly what will
land.

Both were checked by making them fail rather than by reading them. Thirteen throwaway sources in
`features/profile/` failed both; twelve passed both; twelve plus five throwaway TESTS passed both,
which is the "a test rides with its source" clause actually working. Check 6's new `mock.module`
form was checked the same way, and needed `git add -N` first -- check 6 uses `git grep`, so it sees
tracked files only, where checks 5 and 7 use `find` and see everything.

One thing to know if you edit the hook from a worktree, as this arc did. `just git-hooks-install`
symlinks `$(git rev-parse --git-common-dir)/hooks/pre-commit` at the MAIN checkout's copy, and
`--git-common-dir` is shared by every worktree, so the file a commit here actually runs is the one
on `main` -- not the edited copy sitting beside you. The new rule starts firing when this branch
lands. Verify a hook edit by running the file directly, which is what was done above.

The floor is not gated, per `AGENTS.md` as amended at `80315310`.

## Decisions

Forks taken, with the alternative not taken. The standing tiebreakers, both from the desktop
viewer: promote a sibling rather than nest, and when a file could sit in two places, put it with
its callers.

### `origin/dir-clustering` was replaced rather than continued

The remote branch already held a run at this: `794febf3` a ledger, `e785ba7c` the desktop-viewer
grouping, `e3fa4278` a fix to it. All three sit on `6b47d065`, which is BEFORE the import-alias
migration (`7dbbccc5`), so that branch still writes `../../..` everywhere and its fitness gate has
no check 6. Its grouping is not lost: `a6335e5c` on `main` is the same work replayed on top of the
migration, and says so in its own message. The remote branch is a snapshot of a tree that no longer
exists, and rebasing onto it would have handed this branch 69 renames of files whose contents no
longer match anything -- a large conflict for nothing gained.

So this run restarts from `a6335e5c` and takes none of that branch's content. It keeps all of its
history: the stale tip `e3fa4278` is merged in with `-s ours`, which records it as an ancestor and
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

### A move survives a concurrent edit, which is the migration paying for itself again

`main` moved twice during this arc, the second time landing work inside three files R6 had just
moved into `terminal/tmux/`. The merge auto-resolved all three: git detected the renames and
applied the new content to the moved paths. One conflict, in a file that had NOT moved --
`claudeSessionLaunch.ts`, where `main` added a symbol to an import list whose path this branch had
changed. Both sides were right and the resolution takes both, the new symbol on the new path.

That is the whole conflict surface of nine directories of moves against two feature commits: one
import line. Under relative imports every file inside each moved directory would have been rewritten
too, and every one of those would have been a conflict candidate.

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
- **Both suites time out under load, and the timeouts read exactly like real failures.** Ten across
  this arc, every one green on an immediate rerun with nothing changed. Five were
  `transcripts/watchTree.test.ts` at its 20-second limit, during R6, R7 and the final merge --
  corroborated independently by another session, on a diff that never touched that file. The other
  five were panel tests at Vitest's 5-second default: four app-shell renders during R8 and
  `markdown/proseBlocks.test.ts` during R10, none in a directory this arc had moved. The tell is
  the wall clock: the sidecar suite runs in 17s, and every failing run of it took 57 to 59s. So the
  suites are being starved rather than broken, presumably by whatever else is running on this
  machine. Worth someone raising those two limits or finding what blocks; not investigated here.
- **`desktop-viewer/keyboard-input/` and `tile-viewport/` are at 10, and `data-source/` at 12.**
  Under the ceiling and therefore not this arc's business, but each is one or two files from being
  the next task. The gate will say so when it happens.
- **A source path written as a plain string is unguarded.** `app/typeRendering.test.ts` reads two
  components off disk with `readFileSync`, so `tsc` cannot see the reference and moving the files
  broke it with ENOENT. No gate was added: the suite catches it, and the grep in Decisions returns
  eight lines across both trees, six of them CSS.

