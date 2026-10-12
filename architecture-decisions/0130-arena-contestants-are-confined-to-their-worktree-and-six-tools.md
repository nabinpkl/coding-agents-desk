---
status: accepted
date: 2026-10-12
supersedes: ADR-0128
---

# Arena contestants are confined to their worktree and the same six tools, on both harnesses

Supersedes one part of ADR-0128 and nothing else: the Claude command line, whose
`--allowed-tools Read,Grep,Glob,Bash,Edit,Write` it recorded as the contestant's boundary. The
driver seam, the serve's end-of-turn marker and the file facts stand as ADR-0128 records them.

## Context and Problem Statement

A contestant runs unattended, as this machine's user, on a prompt and a repository the run
was handed. An automated review flagged the Claude contestant's unscoped shell; asking what
each harness could actually reach then showed neither was confined by anything the run set.

Measured on 2026-10-12, by having a Claude contestant (CLI 2.1.296, the ADR-0128 command)
read, write, edit and shell into a folder outside its worktree: all four succeeded.
`--safe-mode` keeps the machine's permission mode, which here is `auto`; a bare tool name in
`--allowed-tools` allows that tool on every path; and the contestant also held subagents, web
fetch, cross-session messaging and scheduled triggers. An opencode contestant runs as the
serve's `build` agent, whose rules allow every tool and, on this machine's config
(`external_directory: allow`), every directory, plus the global MCP servers and plugin tools.

## Decision Drivers

- A contestant may do the work a coding prompt needs, in its own worktree, and nothing else
  without a reader present.
- Both harnesses get the same tools, so a bake-off compares agents rather than permissions.
- Nothing in the reader's own config changes: this machine's Claude settings, its opencode
  config and its other sessions are untouched.
- A contestant that cannot be confined is not run.

## Decision Outcome

- **Claude** adds `--permission-mode dontAsk` (refuse whatever no rule allows, nobody asked)
  and `--tools Read,Grep,Glob,Bash,Edit,Write` (every other built-in absent), and allows
  `Read(./**) Edit(./**) Write(./**) Bash`. `./**` resolves against the worktree the process
  starts in; Glob and Grep follow the Read rule. Measured: reads, writes, edits, globs and
  greps outside the worktree denied, the same inside it succeeded.
- **Opencode** sessions get session-scoped rules from the serve's own API, put on with
  `PATCH /api/session/{id}` after creation and before the prompt: deny everything, allow
  `read edit glob grep list bash`, and re-allow the serve's own scratch directories, taken
  from the agent's rules rather than spelled. Session rules are read after the agent's and the
  last match wins. Measured by asking the live serve (2.0.16) to judge actions against a
  session holding them: read, edit and bash allowed; webfetch, websearch, an MCP tool, task,
  question and a directory outside the worktree denied; the tool-output directory allowed.
  A session the PATCH fails on fails the contestant before any prompt is sent.

## Consequences

- **The shell is not confined, on either harness.** Bash reaches wherever this user can, so a
  repository carrying instructions can still direct a contestant outside its worktree through
  it. Opencode checks the paths it can read out of a command; a computed path escapes that.
  Closing it is a sandbox (the VM-per-contestant shape ADR-0127 names), not more rules.
- **Opencode's rules are attached after the session exists**, so for the moment between
  create and PATCH the session holds the agent's rules. Nothing is prompted in that moment.
  The sidecar's session pool sits at the 500-line cap, which is why the rules are not passed
  on create instead.
- The confinement follows the `build` agent's scratch directories. A machine whose default
  agent is another one gets build's list, which at worst denies that agent a scratch path.
- Denied tools may still be described to the model. Whether either harness drops a denied
  tool from the prompt or only refuses the call was not measured; `--tools` does remove
  Claude's from its list.
