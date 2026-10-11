---
status: accepted
date: 2026-10-11
---

# Arena runs fan one prompt out to worktree contestants, recording facts and judging nothing

## Context and Problem Statement

Comparing what different agents (or the same agent twice) do with one prompt needs the prompt
fanned out to several isolated contestants at once, and needs the facts each left behind --
how long, which files, what diff -- recorded where a reader can see them. The panel already
renders sessions from every source; what does not exist is the fan-out, the grouping, and the
facts. This ADR covers `agent-feed/sidecar/src/arena/`, `http/arenaRoutes.ts`,
`agent-feed/wire/arena.ts`, and the panel's Arena surface (`?entry=arena`).

## Decision Drivers

- Recording over judging: the arena never scores or ranks; a reader judges from the facts and
  the sessions, both of which already have surfaces.
- Isolation without invention: each contestant works in its own checkout of the target repo,
  and the target repo is per-run state, not a sidecar constant.
- The contestants are ordinary sessions: a contestant's session is a catalog session from its
  first moment, so every existing session surface already lists it.
- v0 drives opencode contestants only, on this machine's one serve; the Claude driver lands
  later behind the same service seam.

## Considered Options

- A panel-side orchestrator that owns sessions and rendering -- rejected: it duplicates the
  catalog, the backends, and the session surfaces the panel already has.
- One worktree of the target repo per contestant, detached at the run's base ref, under the
  arena's own root -- chosen. A clone per contestant was considered and rejected for v0:
  it costs a full copy plus an install per contestant for the same isolation, and it is the
  shape the VM future needs rather than the one this machine does.
- A shared workspace, all contestants in one checkout -- rejected: contestants writing the
  same file is a merge conflict in the recording, and the facts stop being attributable.

## Decision Outcome

- One run: one prompt, one target repo, one base ref, N contestants. Each contestant gets a
  detached git worktree at `<arenaRoot>/<runId>/<contestantId>` -- a path the sidecar chose,
  never one a request named, the same rule fork worktrees keep. The worktree is removed
  (`--force`, after the diff is captured) when the run is torn down, and `git worktree prune`
  cleans the registrations.
- The arena lives inside the sidecar and drives the opencode backend it already holds:
  `createSession` in the contestant's worktree, one `send`, and the timeline subscription
  both collects the turn's events and signals the close (runState idle with an empty queue,
  after the turn was seen running -- an idle projection before the turn opens is not a
  finished one).
- Facts are rough and flat: duration, files read and written (the adapter's own `files`
  resolution first, the tool input's path keys as the fallback -- measured, the opencode
  mapper resolves `files` only from a call's attachments), context tokens and cost as the
  backend reports them (null when it reports none), and `git diff <baseRef>` bounded at
  256 KB. Untracked files are deliberately not in the diff; `filesWritten` is where they are
  named.
- Runs are persisted (`runs.json`, diffs in per-contestant files beside their run) and
  reloaded on restart, with contestants a restart orphaned marked failed rather than left
  reading as dueling forever.
- A second sidecar on this machine announces on its own board: `AGENT_FEED_ANNOUNCE_DIR`
  keeps the shared board's per-user descriptor (which a second sidecar would overwrite and
  delete on exit) intact. Probes and isolated verification set it; the owner's sidecars do
  not.

## Consequences

- The Claude driver (`claude --print --safe-mode`, probed: auto-allows built-in tools under
  `--allowed-tools`, prompt via stdin, exits when the turn ends) lands behind the same
  `driveOne` call, and the driver seam is extracted when the second implementation arrives --
  one implementation earns no interface yet.
- Contestants on this machine's serve inherit its global plugin context -- measured, an
  arena contestant's first tool call read the taste posture the serve's pre-turn hook
  injects. Same prompt on one machine means same machine context; a VM-per-contestant
  future is the escape, and the run's `repoPath`/per-contestant worktree shape is where it
  plugs in.
- The arena does not stream a contestant's transcript into its tab: sessions are read where
  sessions are already read. The tab carries the grouping and the facts.
