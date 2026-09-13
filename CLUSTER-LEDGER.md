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
| R2 | `packages/AgentPanel/Web/src/features/activity-feed` | 26 (44) | R |
| R3 | `packages/AgentPanel/Web/src/app` | 24 (50) | R |
| R4 | `packages/AgentPanel/Web/src/features/bots` | 20 (23) | R |
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

## Deferred

