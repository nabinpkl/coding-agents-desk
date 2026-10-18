---
status: accepted
date: 2026-10-18
---

# An SDK session's runner is a pipe, and a stale one relaunches with resume when idle

## Context and Problem Statement

ADR-0143 put each SDK session's `query()` in a runner process held by the session's tmux pane, so the
session outlives the sidecar's restarts. That runner also read every message `claude` sent into the
session's state and accepted a fixed list of commands, so any new SDK feature (model switch, rename,
effort) was runner code, and a runner keeps the code it started with. Effort was the case that
showed it: the SDK under every running runner could already set it (`applyFlagSettings`), and no
running session could use it until its runner restarted. The runner files changed five times in two
days after 2026-10-17, every time for a feature. Touches `agent-feed/sidecar/src/claude-sdk/`.

## Decision Drivers

- A sidecar edit, which reloads on save, must be enough for a new SDK capability to reach a running
  session.
- The session survives everything ADR-0143 says it survives: a sidecar restart while a question or
  approval waits loses nothing.
- When the runner itself must change (an SDK upgrade, a launch option, its own code), nobody has to
  notice or act, and nothing in flight is lost.

## Considered Options

- **A thin runner, interpretation in the sidecar, and relaunch-with-resume when stale.** The runner
  forwards every SDK message, calls any `Query` method by name, and holds permission callbacks; it
  keeps the latest record of each kind for a late-connecting sidecar to replay. The sidecar folds
  that into state (`claudeSdkSession.ts`). A runner reports a build (the SDK version and a hash of its
  source files); one older than disk is relaunched with `resume` in its pane once idle.
- **Keep the fat runner, add only the stale relaunch.** Every feature still waits for a relaunch.
- **Handover, as the PTY vault does** (`terminal/pty-manager`, SCM_RIGHTS): pass the session to a
  successor runner without ending it.
- **Hot-swap the runner's logic module inside the live process.**

## Decision Outcome

Chose **the thin runner with relaunch-with-resume**. It is the vault/manager split that kept the PTY
vault unchanged since 2026-07-27, with the sidecar as the manager. Keeping the fat runner fails the
first driver. Handover does not transfer: a PTY is a descriptor whose state the kernel holds, while
an SDK session's state is in the SDK's memory (in-flight control requests, callback promises, a
half-read message buffer), so a successor would have to re-implement the SDK; and it is not needed,
because `claude` keeps the conversation on disk and `resume` brings it back. A relaunch while idle
(no turn, nothing waiting, no background task) loses nothing that matters. Hot-swapping a module
under live callback closures is the fragile kind of clever.

### Consequences

- Good, because a new control method of the SDK is a sidecar change: the runner calls it by name.
- Good, because a stale runner, including one on an older protocol, is relaunched without anyone
  acting. One whose protocol the sidecar cannot read is judged idle by its registry row, and its
  `claude` is hung up the way a terminal session's is.
- Good, because a relaunch keeps the model and effort the session chose. They are read from the old
  runner before it stops and passed to the new one as launch options (`--model`, `--effort`), and
  each runner reports what it was launched with when a sidecar connects, so the next relaunch
  carries them again. Only explicit choices carry: what the CLI reports as its own default is never
  pinned. A runner on an older protocol cannot be read, so its relaunch starts from the defaults.
- Bad, because the runner's socket now accepts any `Query` method rather than a list. It refuses
  `close`, `streamInput` and the iterator's own methods by name; the socket is this user's alone in a
  private directory, as before.
- Bad, because a relaunch ends background shells and agents running inside `claude`, so it waits for
  them; a session that always has one running stays on its old runner.
- Neutral, because the runner's state no longer exists as such: a sidecar rebuilds it from the
  replay on every connect.

### Confirmation

`claudeSdkRunner.test.ts` holds `RUNNER_SOURCE_FILES` to the runner's value imports, so the build
hash covers every file the runner process loads. `claudeSdkClient.test.ts` covers a stale build and
an older protocol both reaching the relaunch. The sidecar logs every relaunch it makes or refuses.

## Links

- ADR-0143 A Claude session can run through the Agent SDK, in a runner held by its tmux pane
- t3code `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, snapshot 2026-10-17:
  applies a selection live where the SDK can, and reopens the query with `resume` where it cannot,
  refusing while background work runs.
