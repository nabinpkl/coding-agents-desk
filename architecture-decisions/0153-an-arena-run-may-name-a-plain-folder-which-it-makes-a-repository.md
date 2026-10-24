---
status: superseded by ADR-0154
superseded-by: ADR-0154
date: 2026-10-23
amends:
  - ADR-0127 a run's target is a git repository, asserted before any worktree
  - ADR-0135 only a run that names no repository gets one made
---

# An arena run may name a plain folder, which it makes a repository

## Context and Problem Statement

The arena's new-run form chooses its repository with the project picker the session and Bot
dialogs use, which lists every folder agents have worked in and can browse to or make any folder
under home. Many of those are not git repositories, and ADR-0127 refused a run on one, after the
reader had filled the form in, with git's own message (as a 500). The reader asked that a plain or
new folder work, and that the form say which projects are not repositories before a run is asked
for. Touches `arena/arenaWorktrees.ts` (`inspectArenaFolder`, `initRunRepository`),
`arenaService.ts` (`createRun`, `inspectFolders`), `arenaRequest.ts`, the `/api/arena/folders`
route, the wire's `ArenaFolderCheck`, and the panel's `ArenaNewRun` and `ProjectPicker`.

## Decision Drivers

- Every lane starts at the folder as the reader left it: its files, not an empty checkout.
- Writing `.git` into a folder the reader named is the one write here into their own tree; it is
  bounded to where the folder browser is already confined.
- A run never deletes the reader's folder, nor anything in it.
- The form says what a run would do with a folder before the run is asked for.

## Considered Options

- **Make a plain folder a repository, its files the first commit.**
- **Copy the folder into the run's own repository** and leave the original untouched.
- **Keep refusing**, and only say so earlier in the form.

## Decision Outcome

Chose **make it a repository, its files the first commit**. A copy leaves the lanes' work in a
folder the reader did not choose, so nothing they do lands where they look for it, and copying a
large folder is the cost of a run's start. Refusing is the problem the reader asked to remove.

A run that names a folder inspects it first, off the filesystem: a folder that has `.git`, or a
folder above it that has, is in a repository and used as before. A plain folder inside the home
folder is made one: `git init -b main`, every file it holds added (its own `.gitignore` honoured),
and one commit, "<run name>: the folder as found", authored as the arena with signing and hooks off,
as ADR-0135's own repositories are. Anything else refuses the run with a 400 naming why: not an
absolute path, does not exist, not a folder, cannot be read by the sidecar, or a plain folder outside
home. The commit is made after the run's folder is claimed, beside the worktrees, so a refused
request writes nothing. A plain folder made a repository is not the run's own: `repoCreated` stays
false, and deleting the run leaves the folder and its repository alone.

`POST /api/arena/folders` answers the same inspection for up to 500 paths. The new-run form asks it
about every listed project and the one chosen, and the picker shows it under each row: a plain
folder says the run makes it a repository, and a folder a run would refuse says why and cannot be
chosen.

### Consequences

- Good, because any project the picker lists, or any folder made in it, can be a run's repository.
- Good, because the form says before the run what it will do to a folder, and refuses up front what
  it would refuse later.
- Bad, because a run on a plain folder leaves a repository there for good, with the arena's commit
  as its first; a run whose worktrees then fail leaves it too, since it holds the reader's files.
- Bad, because a large folder (a `node_modules` with no `.gitignore` to leave it out) is committed
  whole, and the run waits for it.
- Neutral, because inspection reads `.git`'s presence, not git: a `.git` git cannot read passes the
  check and fails the run at its first worktree, with git's reason.

### Confirmation

`arenaWorktrees.test.ts` pins the inspection and the commit against real git;
`arenaService.folders.test.ts` pins that a plain folder is made a repository, that a repository is
not, and that a refusal writes nothing; `arenaRoutes.test.ts` pins the route;
`ArenaSurface.newRun.test.tsx` pins the notes in the form.

## More Information

- ADR-0127: arena runs and their worktrees.
- ADR-0135: a run's own repository, and what deleting a run removes.
