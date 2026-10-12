---
status: accepted
date: 2026-10-12
supersedes: ADR-0130
superseded-by: ADR-0132
---

# An arena opencode session holds its confining rules from the create request itself

Supersedes one part of ADR-0130 and nothing else: how an opencode contestant's session gets
its rules, and the consequence that followed from it. The rules themselves, the Claude flags,
and the unconfined shell stand as ADR-0130 records them.

## Context and Problem Statement

ADR-0130 put the rules on with `PATCH /api/session/{id}` after the session was created,
because the file that created sessions (`opencodeSessionPool.ts`) sat at the 500-line cap. So
each contestant's session briefly existed holding the agent's rules, which on this machine
allow every tool and directory. Nothing was prompted in that gap, but the order was a
workaround of the cap rather than the design: the serve takes the rules on create.

## Decision Outcome

- **Creating a serve session moves from the pool to the backend.** It is one remote call that
  touches none of the pool's state; ownership already started at `open`. The pool drops to 479
  lines with nothing split, and `OpencodeAgentBackend.createSession` takes optional
  `permissions` that ride the create request.
- **The arena reads the rules first and creates with them.** If the agent list cannot be read,
  no session is created.
- **The field travels as `$body_permissions`.** SDK 1.18.31 predates the serve's `permissions`
  on create, and its request builder copies only the body keys it knows, dropping the rest with
  no error. Measured: a plain `permissions` key compiled under a cast and the serve stored no
  rules. The builder's own escape for extra body keys, `$body_<name>`, delivers it. Measured
  live through the backend: all eleven rules stored; read, edit and bash allowed in the
  worktree; webfetch, an MCP tool, task and a directory outside it denied; the serve's
  tool-output directory allowed; a session created without rules unchanged.

## Consequences

- No moment exists in which an arena opencode session holds the agent's wider rules.
- A newer SDK that knows the field makes `$body_permissions` unnecessary. Without the backend's
  unit test spelling it, an upgrade could silently go back to dropping the rules. That test
  pins the spelling, and only a live create proves the serve stored them.
