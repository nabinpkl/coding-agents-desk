---
status: accepted
date: 2026-10-13
---

# A Claude contestant runs with this machine's own setup, without `--safe-mode`

Amends ADR-0128, whose Claude command passed `--safe-mode` as the context control. ADR-0130's
confinement (`--permission-mode dontAsk`, `--tools`, the `./**` allow rules) is unchanged.

## Context and Problem Statement

`--safe-mode` drops this machine's hooks, CLAUDE.md discovery, skills, plugins and MCP servers
from a Claude contestant. In the terminals mode the contestant is a session the reader watches and
types into, and in safe mode it is not the Claude this machine's owner uses: the CLI says "Restart
without --safe-mode to re-enable" at the top of every Claude lane. The owner asked for the flag to
go.

## Decision Outcome

- **Neither the print nor the interactive command passes `--safe-mode`.** A contestant loads this
  machine's setup the way a reader's own session does.
- **The cost, measured on 2.1.296:** the same one-word prompt ("Reply with exactly the word alder
  and nothing else") ran at 8.5k tokens of context with `--safe-mode` and 315,540 without it (32% of
  the window), and the contestant read the machine's session-start hook before answering. A
  contestant's context is now mostly this machine's, and a bake-off's token and cost facts carry
  that.
- The confinement still holds: tools outside `--tools` stay absent, and anything no rule allows is
  refused under `dontAsk`, which covers MCP tools the machine's servers bring.

## Links

- ADR-0128: the Claude command this amends.
- ADR-0130: the confinement, unchanged.
