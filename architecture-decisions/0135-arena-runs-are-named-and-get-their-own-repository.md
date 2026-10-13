---
status: accepted
date: 2026-10-13
---

# Arena runs are named, live in a folder in the arena home, and get a repository of their own

Supersedes ADR-0127 on where a contestant's worktree goes (`<arenaRoot>/<runId>/<contestantId>`)
and on the configured default repository (`AGENT_FEED_ARENA_DEFAULT_REPO`). Everything else in
ADR-0127, and ADR-0133/0134's terminals mode, stands.

## Context and Problem Statement

A run needed a repository path typed in before it could start: the only default was an
environment variable, unset on this machine, so a blank form was refused. A run also had no name,
only a uuid, and its worktrees sat under that uuid in Application Support, where a reader does not
browse. The owner asked for a blank form to be a run: a default home for arena work (`~/.arena`),
a default name ("arena run 1", "arena run 2", ...), and a new repository for that name holding
the contestants' worktrees, so Open lanes goes straight to empty feeds with terminals ready.

## Decision Outcome

- **The arena home is `~/.arena`** (`AGENT_FEED_ARENA_HOME` overrides). The run index and the
  contestants' diffs stay under the arena root in Application Support: that is the sidecar's
  record, the home is where the work is.
- **Every run has a name, unique on the machine.** A run that gives none gets one past the
  highest "arena run N" among the runs' names and the home's `arena-run-N` folders, so a folder
  whose record was lost still holds its number. `GET /api/arena/new-run` answers the next name
  with the modes and the home, for the composer to show; it replaces `GET /api/arena/modes`.
- **The name gives the run's folder,** `<arenaHome>/<name in lower case, other characters as
  hyphens>`. The folder is made without `recursive`, so making it is what claims the name: a
  folder already there refuses the run, and two runs asking for one name at once cannot both win.
  A refused request leaves no folder.
- **Worktrees go in the run's folder** as `c1`, `c2`, ..., whichever repository they are of.
- **A run that names no repository gets its folder as a new one:** `git init -b main`, the
  worktree folders listed in `.git/info/exclude` so the checkout's own status stays clean, and one
  empty commit authored as the arena with signing and hooks off, so no machine's git identity or
  global hook can stop a run. `repoCreated` on the run says so.
- **Removing a run removes its folder**: whole when it is the run's own repository; only when
  empty when it held worktrees of a repository the run named, and a refusal is logged rather than
  emptied. Only a folder directly in the home with a run folder's name is ever removed.
- **No compatibility for the old shape.** The store requires `name`, `folder`, `repoCreated` and
  `mode`; the store was empty when this landed.

## Consequences

- A fresh repository has nothing tracked, so a contestant's new files are not in its diff; they
  are named in `filesWritten`, the same boundary ADR-0127 drew for untracked files.
- Every run's folder is new, so a Claude contestant meets its folder-trust question in every run,
  answered in its lane. The arena does not pre-answer it: trust is recorded in Claude's own
  files, which are read-only to it.

## Links

- ADR-0127: arena runs and their worktrees.
- ADR-0133, ADR-0134: the terminals mode and lanes opened before the prompt.
