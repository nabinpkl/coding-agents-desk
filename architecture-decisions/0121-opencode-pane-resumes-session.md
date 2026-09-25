---
status: accepted
date: 2026-09-25
---

# Opencode session pane resumes onto its session

## Context and Problem Statement

ADR-0120 gave opencode threads the same two terminals Claude threads have, but chose plain
`opencode` for the session pane (Option B): the serve owns opencode sessions, so resuming looked
like a second client, and the reader picked the session up in the TUI's picker. Readers asked for
the Claude behaviour instead: the pane cded to the session's directory with opencode already
entered, landing directly on that session the way `claude --resume <id>` does.

## Decision Drivers

- The pane must land on the session, not the picker: one open, one session, no extra step.
- One open joins rather than starts beside the first: the deterministic
  `agentdesk-opencode-<id>` pane name stays.
- The second-client concern from ADR-0120 stands but is accepted the same way Claude's is: the
  live pane is joined when it exists (stamp), and the resume is only the fallback that starts it.

## Considered Options

- **Option A**: Resume directly (`opencode --session <ses_id>`) in the session's directory.
- **Option B (status quo)**: Plain `opencode` in the session's directory, reader picks the session.

## Decision Outcome

Chose **Option A** because the reader asked for the Claude shape and the join-by-name guard
already handles the second-open case; a resumed second client to the serve is the same trade-off
the Claude pane already makes. The directory shell below the composer is unchanged (login shell
in the session's directory).

### Consequences

- Good, because opening the session pane lands on the session immediately, matching Claude.
- Good, because no panel code changes: the same toggle, control, and pane key off the argv the
  sidecar builds.
- Bad, because a pane started this way is a second TUI client to a serve-owned session, which is
  what ADR-0120 deferred.
- Neutral, because the pane name, stamp-only lookup, and join path are unchanged.

### Confirmation

`agentTerminalSessionPane.test.ts` pins the `["opencode", "--session", <id>]` argv, the pane name,
and the join path; `agentTerminalService.test.ts` still pins the directory shell.

## Pros and Cons of the Options

### Option A

- Good, because the pane lands on the session with no picker step.
- Bad, because it is a second client to a serve-owned session.

### Option B

- Good, because it never opens a second client.
- Bad, because every open lands on the picker instead of the session.

## Links

- ADR-0120 (opencode thread terminal, Option B)
- ADR-0108 (Agent Panel terminal flow)
