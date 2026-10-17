---
status: accepted
date: 2026-10-13
supersedes:
  - ADR-0130
  - ADR-0131
  - ADR-0136
---

# Arena contestants run as plain agents, and the arena records what each reached outside its worktree

Supersedes ADR-0130 (contestants confined to their worktree and six tools), ADR-0131 (an opencode
session holds its rules from the create request) and ADR-0136 (Claude's Write confined by its Edit
rule). ADR-0138 (no `--safe-mode`) stands.

## Context and Problem Statement

ADR-0130 confined each contestant with permission rules: Claude ran under `--permission-mode
dontAsk`, `--tools Read,Grep,Glob,Bash,Edit,Write` and `--allowed-tools Read(./**) Edit(./**)
Bash`; an opencode session was created holding a deny-all rule set that re-allowed the same six
tools. It was never a wall. Bash was unscoped by design, and Claude's own refusal message says the
model may try another tool -- on a live run a Claude contestant whose Read of a file outside its
worktree was refused read it with `cat` instead, while an opencode contestant took the same refusal
and went on without the file. So the rules changed what a contestant could do in ways that were
partly a test of the harness, while not stopping the one reach that matters for a fair duel: a
contestant reading its rival's worktree, which sits in the next folder.

Real isolation needs an OS sandbox (`sandbox-exec` per contestant, and for opencode a standalone
TUI with its own database file) or a container; that is a later decision. Until then the owner
chose plain agents and visibility.

## Decision Outcome

- **Contestants run as plain agents.** Claude runs with no `--permission-mode`, `--tools` or
  `--allowed-tools`, so it has this machine's permission mode and every tool a reader's own session
  has. An opencode contestant's session is created with no rules of its own and runs as the serve's
  `build` agent.
- **Each contestant records `outsideReached`** at close, read off its events (`outsideReaches` in
  `arenaFacts.ts`): every path outside its own worktree that a file tool read or wrote, a search
  tool searched, or a shell command named (absolute, `~`, or climbing with `..`, resolved against the
  worktree). A path in a rival's worktree, or a rival Claude contestant's transcript file, is marked
  with that rival's id. The machine's own directories (`/tmp`, `/usr`, `/dev`, ...) and each
  harness's own spill of long tool output are left out as noise. A shell path is the command's
  text, not proof the shell opened it.
- **The panel shows it**: an "Outside its folder" row in every lane's facts (a rival reach in the
  destructive ink, naming the rival), and every place listed in the Files view.

### Consequences

- A contestant can read, write and run anything this user can, rival worktrees included. The
  arena records that it did; it does not stop it.
- A headless Claude contestant runs `--print` under the machine's permission mode. A tool that mode
  would ask about is refused in print mode, since nobody can answer.
- The record is read at close, so a live run shows reaches only once each contestant settles.

## Links

- ADR-0130, ADR-0131, ADR-0136: the confinement this removes.
- ADR-0138: contestants run with the machine's own setup.
