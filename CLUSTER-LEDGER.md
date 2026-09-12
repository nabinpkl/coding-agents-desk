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
| R1 | `agent-feed/sidecar/src/http` | 36 (62) | R |
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
exists, and rebasing this work onto it would reintroduce every relative import the migration
removed.

So this run restarts from `79f79128` and takes none of that branch's content. It keeps all of its
history: the stale tip `30ced4e2` is merged in with `-s ours`, which records it as an ancestor and
changes not one byte of the tree, so the push is an ordinary fast-forward and nothing on the remote
is discarded. The alternative was a force-push, which reaches the same tree by throwing the old
commits away; there is no reason to destroy history that costs nothing to carry. The second
alternative, a new branch name, loses nothing either but leaves two branches with one name's worth
of meaning and the wrong one on top.

## Deferred

