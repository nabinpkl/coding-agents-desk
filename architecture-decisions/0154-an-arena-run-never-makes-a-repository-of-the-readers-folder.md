---
status: accepted
date: 2026-10-23
supersedes:
  - ADR-0153 a run makes a plain folder it names a repository
---

# An arena run never makes a repository of the reader's folder; the reader asks for one

## Context and Problem Statement

ADR-0153 had a run that named a plain folder make it a git repository on its own, its files the
first commit, the moment the run started. The reader asked for the run to offer that instead of
doing it: writing `.git` into one of their folders, for good and with everything in it committed,
is theirs to decide, not a side effect of starting a run. Touches `arena/arenaService.ts`
(`createRun`), `arena/arenaWorktrees.ts` (`makeFolderRepository`), the
`/api/arena/folders/repository` route, the wire's `ArenaMakeRepositoryRequest`, and the panel's
`ArenaNewRun` and `ProjectPicker`.

## Decision Drivers

- Nothing the reader did not ask for writes into their own folder.
- The offer is where the reader sees the folder, before a run is asked for.
- What makes a folder a repository, and the repository it makes, stay ADR-0153's.

## Considered Options

- **A run refuses a plain folder; the folder's row offers to make it a repository**, done on that
  click alone.
- **A run takes a `makeRepository` flag**, set by the form after asking the reader at start.
- **Keep ADR-0153**: the run makes it one, and the form says it will.

## Decision Outcome

Chose **the row's offer, and a run that refuses**. A flag on the run request keeps the write inside
starting a run, where a manager calling the API could set it as easily as the reader; a separate
request the form sends only from the reader's click keeps the two acts apart. Keeping ADR-0153 is
what the reader asked to change.

A run naming a plain folder is refused with a 400, `"<path>" is not a git repository yet`, and
nothing is made. `POST /api/arena/folders/repository` with a folder's path makes it a repository
exactly as ADR-0153 described (inside the home folder only; `git init -b main`, every file added,
one commit, here "The folder as the arena found it", authored as the arena with signing and hooks
off) and answers the folder as a run would now take it. A folder already in a repository is
answered as it is; a folder a run could not use is refused with its reason. In the new-run form a
plain folder's row reads "Not a git repository", cannot be chosen, and has a "Make it a git
repository" button beside it; once made, the row can be chosen like any other. A failure stays on
the row with the sidecar's reason, and the button offers it again.

### Consequences

- Good, because no run, and no manager driving runs, writes into the reader's own folder.
- Good, because the reader decides with the folder in front of them, before filling in the rest.
- Bad, because a plain folder takes one more click before a run can use it.
- Neutral, because a repository made this way is still the reader's for good, and a run deleted
  later still leaves it alone (ADR-0153).

### Confirmation

`arenaService.folders.test.ts` pins that a run refuses a plain folder and makes nothing, and that
the reader's request makes one a run then takes; `arenaRoutes.test.ts` pins the route;
`ArenaSurface.newRun.test.tsx` pins that the form makes nothing until the button is pressed.

## More Information

- ADR-0153: how a plain folder is inspected and made a repository.
