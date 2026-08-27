---
status: accepted
date: 2026-07-13
superseded-by: ADR-0108
---

# Bottom Agent Panel terminal

## Context and Problem Statement

The Agent Panel needs an on-demand terminal for the selected Claude or Codex session while keeping
the activity feed visible. Existing AgentDesk workspace terminals are persistent multiplexer sessions
that survive detach, but an agent-resume process must be owned by the visible panel workflow, must not
compete with a harness already live elsewhere, and must be cleaned up when that workflow ends. This
decision extends the AgentDesk-owned PTY architecture from ADR-0053 without changing its package,
process, or transport ownership.

## Decision Drivers

- One harness session must map to at most one panel-owned resume process across macOS and iOS.
- Harness commands and arguments must be constructed and validated by the host, never supplied as
  executable text by WebKit or the iPhone.
- Normal workspace shells must retain their survive-detach behavior while panel-owned resume
  processes have bounded cleanup after transport loss.
- Explicit user and panel lifecycle actions must terminate immediately; involuntary disconnects must
  allow a short reattach window.
- Terminal input, rendering, selection, paste, control keys, and resize must remain native SwiftTerm
  behavior rather than a second terminal implementation in React or a JavaScript bridge.
- AppKit and UIKit must own their respective layout and lifecycle integration over one shared terminal
  content component and one host-owned session coordinator.

## Considered Options

- **Option A**: Add a host-coordinated, deterministic leased PTY for each Agent Panel harness session,
  rendered by shared native SwiftTerm content in platform-owned bottom panes.
- **Option B**: Reuse ordinary persistent workspace terminals and inject a resume command as terminal
  input.
- **Option C**: Render and drive the resume process inside the AgentPanel webview.

## Decision Outcome

Chose **Option A**. The host derives the deterministic PTY name
`agent-resume-<source>-<session-id>` from a validated harness source and UUID session id. Reopening the
same session attaches that PTY instead of launching another harness. If ATC reports the harness session
live but the deterministic panel-owned PTY does not exist, the coordinator rejects the request with
`activeElsewhere`; it does not start a competing resume.

The webview and iPhone send only normalized context: project path, source (`claude` or `codex`), and
harness session id. The host validates that context and owns command construction. Claude launches as
`claude --resume <id>` and Codex as `codex resume <id>` through the user's login zsh so a GUI-launched
host resolves the user's CLI environment. The launch remains an executable plus an argument array
through PTY protocol v4 and Rust `CommandBuilder`: the constant login-shell forwarding wrapper does
not interpolate the session id, arguments are never joined into a shell command string, and no command
is injected as terminal input.

PTY protocol v4 replaces the current v3 create/attach shape with an explicit launch choice (`ShellLaunch` or
`CommandLaunch { executable, arguments }`) and a session lifetime (`persistent` or `leased`). Existing
workspace terminals request `persistent + ShellLaunch` and keep the ADR-0053 survive-detach contract.
Agent Panel resume terminals request `leased + CommandLaunch`.

For a leased PTY, detach, close-client, or socket loss starts the configured reconnect grace only after
the final attached client lease disappears. Another attached client keeps the process alive; reattach
within grace cancels reaping and preserves the PTY and PID. If no lease exists when grace expires,
`pty-manager` kills the harness and removes all session/client registry state. Natural process exit,
explicit kill, and manager shutdown also remove leased state and cancel pending reaps.

Explicit Agent Panel close is not a detach. Terminal close, back/context change, session replacement,
iOS surface switch or teardown, macOS Agents-window hide or close, revoke, and app termination tell the
host coordinator to kill and remove the leased PTY immediately. Unexpected renderer loss, transport
loss, or iOS suspension detaches and uses the reconnect grace. With both Mac and iPhone attached, only
the final lease disappearing can schedule a reap.

The panel is composed natively: the existing AgentPanel webview remains the feed and emits only
session-scoped open/close/context-ended intent. AppKit on macOS and UIKit on iOS own a vertical layout
with the webview above, a native resize handle, and shared `PtyTerminalSwiftTerm` content below. That
shared content owns SwiftTerm input delegation, output, paste, focus, and resize. The macOS adapter
calls the host coordinator directly. The iOS adapter opens through AgentDesk session protocol v7 and
attaches to the returned PTY over `.terminal` with `createIfMissing=false`. The host coordinator and
`pty-manager`, not either platform view, own process identity and lifecycle.

### Consequences

- Good, because deterministic identity and serialized host coordination prevent duplicate resume
  processes across Mac and iPhone.
- Good, because direct argv launch preserves argument boundaries and keeps untrusted surfaces from
  choosing executables or shell text.
- Good, because persistent workspace terminals and leased panel terminals have explicit, testable
  lifetime contracts instead of one ambiguous detach rule.
- Good, because native SwiftTerm behavior is shared without coupling AppKit layout to UIKit layout.
- Bad, because PTY protocol v4 and AgentDesk session protocol v7 are breaking changes and ship without
  v3/v6 compatibility shims.
- Bad, because correctness depends on coordinated explicit-close signals plus a configured reaping
  timer for involuntary loss.
- Neutral, because ADR-0053 remains authoritative for the AgentDesk-owned Rust manager, Swift client,
  and opaque host bridge; this ADR adds launch and lifetime semantics inside that ownership boundary.

### Confirmation

- Protocol tests preserve executable/argument boundaries, require an explicit lifetime, and prove
  persistent detach survives while leased final detach reaps after grace.
- Coordinator tests prove concurrent Mac/iPhone opens create one process, reattach preserves PID,
  explicit close kills immediately, final-lease behavior is correct, and `activeElsewhere` never
  starts a process.
- UI tests prove the feed shrinks above native SwiftTerm content and React/AgentPanel contains no
  terminal input or rendering implementation.
- Session handshake tests reject protocol versions below 7, and no PTY protocol-v3 compatibility path remains.

## Pros and Cons of the Options

### Option A

- Good, because it preserves native terminal semantics and gives resume processes bounded ownership.
- Bad, because it requires coordinated changes to both protocols and both platform adapters.

### Option B

- Good, because it could reuse the current workspace-terminal UI unchanged.
- Bad, because command injection loses argv integrity and persistent detach leaves panel-owned harnesses
  running after their context ends.

### Option C

- Good, because layout would remain inside one webview.
- Bad, because it duplicates terminal input/rendering semantics and gives JavaScript an executable
  control surface.

## Links

- `SPEC.md` Agent Panel Terminal Flow, Wire Shapes, and Lifecycle
- ADR-0030 single QUIC session transport
- ADR-0035 phone-side agent-feed observability surface
- ADR-0052 AgentDesk owns the agent workspace
- ADR-0053 AgentDesk owns the terminal PTY packages
- ADR-0054 shared workspace foundation and macOS reveal-chrome port
