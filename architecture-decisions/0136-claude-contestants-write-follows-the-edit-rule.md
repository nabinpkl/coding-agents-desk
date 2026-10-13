---
status: accepted
date: 2026-10-13
---

# A Claude contestant's Write is confined by its Edit rule, with no Write rule of its own

Amends ADR-0130's Claude allow list, which was `Read(./**) Edit(./**) Write(./**) Bash`. The rest
of ADR-0130 stands.

## Context and Problem Statement

Claude Code 2.1.296 prints, at the top of every contestant's session: "Permission allow rule
(--allowed-tools): Write(./**) is not matched by file permission checks -- only Edit(path) rules
are. Use Edit(./**) instead (Edit rules cover all file-editing tools)." The rule did nothing, and
the warning sat at the top of every Claude lane in the terminals mode.

## Decision Outcome

- **The allow list is `Read(./**) Edit(./**) Bash`.** `--tools` still holds Write; its paths are
  judged by the Edit rule.
- Measured on 2.1.296 under the same flags (`--permission-mode dontAsk`, `--tools
  Read,Grep,Glob,Bash,Edit,Write`): Write of a new file inside the starting folder succeeded,
  and Write of a new file outside it was refused and left no file.

## Links

- ADR-0130: contestants confined to their worktree and the same six tools.
