# TASKS: v5 per-session Agent Panel input terminals

`R<N>` = remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This ledger continues from the archived v4 ledger
(`tasks/archive/2026-07-12-v4-shared-workspace-reveal-shell.md`, through R57); v5 starts at R58.

## Position

Each Agent Panel session thread gets an on-demand native terminal at the bottom of the panel. The
activity feed stays visible above it and shrinks as the terminal grows. SwiftTerm and the existing
PTY client own keyboard, paste, selection, escape/control input, rendering, and resize semantics;
the Agent Panel does not reproduce terminal input in React or route keystrokes through JavaScript.

The terminal resumes the selected harness session with its native command (`claude --resume <id>`
or `codex resume <id>`). It is not an ordinary persistent workspace terminal: it is a leased
`agentResume` PTY owned by the visible Agent Panel workflow. Explicit navigation, close, surface
switch, or macOS window hide kills it immediately. An unexpected transport loss gets a short
reconnect grace; after the last client lease is gone and that grace expires, `pty-manager` kills the
harness and removes the PTY. Existing workspace terminals retain their current survive-detach
contract.

Ordering and reasons:

- ADR-0056 fixes the lifecycle and ownership contract before protocol or UI code lands (Phase 0).
- The PTY protocol gains explicit launch and lifetime semantics before either app asks it to resume a
  harness (Phase 1 before Phases 3-5). Input injection into a shell is not an intermediate path.
- The host coordinator owns harness command construction and deduplication before platform UI joins,
  because GUI-launched processes do not have a reliable shell `PATH` and two opens must not create two
  resume processes (Phase 2 before Phases 4-5).
- The authored Agent Panel webview in the ATC sibling emits session-scoped open/close intent only;
  native containers own SwiftTerm and layout (Phase 3 before platform integrations).
- macOS and iOS consume the same coordinator contract and shared SwiftTerm content, but keep their
  platform layout/lifecycle adapters separate (Phases 4 and 5).
- Automated lifecycle gates land before any host/device launch. Physical installation and launch
  remain an explicit human checkpoint (Phase 6 before Phase 7).

## Lifecycle contract

| Event | Required result |
| --- | --- |
| Open on an idle session | Create or attach `agent-resume-<source>-<session-id>` |
| Reopen the same panel-owned session | Attach the existing PTY; do not launch another harness |
| Explicit terminal close | Kill the harness and remove the PTY immediately |
| Navigate back or select another session | Kill the old session terminal before changing context |
| Switch away from Agent on iOS | Kill immediately |
| Hide or close the macOS Agents window | Kill immediately while preserving the feed webview |
| Unexpected connection loss or suspension | Detach and start the configured reconnect grace |
| Reconnect within grace | Reattach the same PTY/PID and cancel reaping |
| Last lease absent when grace expires | Kill the harness and remove the PTY |
| Harness exits naturally | Remove the PTY and report the exit immediately |
| Mac and iPhone both attached | Reap only after the final lease disappears |
| Session is live outside an Agent Panel PTY | Report `activeElsewhere`; do not start a competing resume |

## v5 Phase 0: decision and compatibility gate

No behavior code lands until the lifecycle owner, protocol boundary, and compatibility consequence are
recorded.

- [ ] R58. Add and accept ADR-0056 for the bottom Agent Panel terminal. Record: native SwiftTerm
  composition; deterministic per-harness-session identity; direct argv launch; `persistent` versus
  `leased` PTY lifetime; final-lease reaping; explicit-close semantics; active-elsewhere rejection;
  host-owned command construction; and the macOS/iOS ownership split. Update `SPEC.md` with the new
  Agent Panel terminal flow, PTY v2 inner protocol, and AgentDesk session protocol v7 requirement.
  Test/verification: ADR index is consistent, accepted ADRs remain untouched, and `rg` finds no
  conflicting description that says all PTYs survive detach.

## v5 Phase 1: explicit PTY launch and leased lifetime

This phase changes the in-tree PTY pair in lockstep. It does not add an Agent Panel UI.

- [ ] R59. Replace the v1 `CreateOrAttach.shell` shape in `terminal/pty-manager/proto/pty.proto` with
  an explicit launch oneof (`ShellLaunch` or `CommandLaunch { executable, arguments }`) plus
  `SessionLifetime { persistent, leased }`; include lifetime in session summaries. Bump the inner PTY
  protocol to v2 and regenerate both Rust and Swift bindings. Update every existing caller to request
  `persistent + ShellLaunch` explicitly; no v1 compatibility shim. Tests: Rust protocol round trips
  and `PtyClientSwiftTests` preserve executable/argument boundaries, lifetime, and current shell
  creation semantics.
- [ ] R60. Refactor `PtySession::spawn` to execute either the existing login-interactive shell or a
  direct executable with argv. Command arguments remain an array from request to `CommandBuilder`;
  no joined command string, shell quoting, or terminal-input injection. Preserve TERM/COLORTERM/
  TERM_PROGRAM/PTY_SESSION and PTY sizing. Tests: a fixture executable receives exact arguments
  containing spaces/metacharacters; ordinary shell sessions still report interactive login-shell
  behavior and the existing terminal environment.
- [ ] R61. Add leased-session ownership to `PtyManagerState`. A leased session schedules a reap only
  when its final attached client disappears through detach, close-client, or socket loss; reattach
  cancels the pending reap; explicit kill and natural exit cancel it and remove all registry/client
  state. The grace duration is injected through `PtyManagerOptions` and the host's central config,
  with a production default of 30 seconds and short test values. Tests: persistent detach survives;
  leased final detach reaps; one of two clients detaching does not; reconnect preserves PID; dropped
  sockets reap; explicit kill is immediate; natural exit leaves no session; manager shutdown leaves
  no leased harness child.

## v5 Phase 2: one host-owned harness terminal coordinator

The host is authoritative for translating a normalized harness source/session into a local process.
The webview and iPhone never supply arbitrary executable text.

- [ ] R62. Add pure `AgentResumeTerminalIdentity` and `AgentResumeLaunch` models. Validate source as
  exactly `claude | codex`, require a UUID session id, require an absolute project directory under the
  user's home, and derive one deterministic PTY name per source/session. Build command launches with
  positional arguments through the user's login zsh so GUI launch can resolve the real CLI without
  interpolating the session id: Claude `claude --resume <id>`, Codex `codex resume <id>`. Optional
  executable overrides live in `Config`, not source literals. Tests pin validation, deterministic
  naming, and exact argv for both harnesses.
- [ ] R63. Add `AgentSessionTerminalCoordinator` over an injected `PtyClient`. It serializes opens by
  deterministic name, creates a leased PTY once, holds a bootstrap attachment during native-client
  handoff, cancels duplicate opens, releases the bootstrap only after attachment acknowledgement,
  and kills on failed/timed-out handoff. Existing panel-owned PTYs are attached rather than resumed
  again. If ATC marks the session live and no deterministic PTY exists, return `activeElsewhere`.
  Tests: concurrent opens produce one process; handoff timeout cleans up; second platform attachment
  reuses PID; failed launch returns a typed error and leaves no PTY.
- [ ] R64. Extend the host/client AgentDesk wire at session protocol v7 with terminal open, ready,
  attached-ack, close, ended, and typed-error messages carrying request id, project path, source,
  harness session id, and PTY session name where applicable. Route iOS requests through the existing
  authenticated input lane and terminal readiness back through the owned Agent push path; route the
  local macOS panel directly into the same coordinator. Tests cover encode/decode, version rejection,
  stale request ids, duplicate close, and a ready response that arrives after context changed.

## v5 Phase 3: Agent Panel intent and shared terminal content

The canonical web UI is authored in the ATC sibling and built into AgentPanel resources. Generated
`packages/AgentPanel/.../AgentPanelWebview` output is never hand-edited.

- [ ] R65. Extend `AgentPanelRequest` and the ATC `WebkitHostBridge` contract with session-scoped
  terminal open/close/context-ended intent. In `dashboard/webview/App.tsx`, add a fixed bottom launcher
  on the thread view only: terminal icon plus `Open Claude` or `Open Codex`. Opening enters a loading
  state; native ready/error/ended events update the bar. Back navigation, session replacement, and
  `pagehide` emit context-ended before leaving. Tests: project/session lists have no terminal action;
  the thread request carries the exact project/source/session; back closes before navigation; stale
  ready events cannot reopen a terminal for another session.
- [ ] R66. Extract the reusable SwiftTerm content from the existing iOS `TerminalPaneView` and macOS
  `SwiftTermPtyManagerTerminalWindow` into the existing `PtyTerminalSwiftTerm` product. It owns
  TerminalView input delegation, paste/bracketed-paste, output feeding, focus, PTY driver, and resize;
  platform containers supply chrome and constraints. Rewire the current full-screen iOS Terminal and
  macOS terminal window to consume it before Agent Panel does. Tests preserve current paste, input,
  output, resize, and detach behavior; no second terminal input implementation appears in AgentPanel
  or React.

## v5 Phase 4: macOS bottom terminal

- [ ] R67. Change `AgentWindowController` from a webview-only content view to an AppKit vertical
  container: AgentPanel webview above, native resize handle, shared SwiftTerm content below. Closed
  state shows only the webview's bottom launcher; open defaults to 38% height and clamps drag resizing
  to 25-65%. The feed shrinks rather than being covered. The local transport calls
  `AgentSessionTerminalCoordinator`, attaches the returned PTY, acknowledges handoff, and surfaces
  launch/error/exit state to the webview. Tests cover constraints, clamping, one terminal per panel,
  and stale async completion after session change.
- [ ] R68. Wire explicit macOS lifecycle: terminal close, back/context-ended, window toggle-to-hide,
  `windowShouldClose`, and app termination kill the leased PTY immediately; hiding the window still
  preserves the existing feed webview and subscriptions. Unexpected renderer/socket loss detaches and
  relies on manager grace. AX identifiers cover launcher, splitter, terminal content, status, and
  close. Tests prove hide kills once, show does not resurrect an old PTY, and stop leaves no terminal.

## v5 Phase 5: iOS bottom terminal

- [ ] R69. Change `AgentFeedSurface` into a UIKit vertical container with the AgentPanel webview above,
  native resize handle, and shared SwiftTerm content below. It opens through the v7 host coordinator
  request, attaches over a dedicated `.terminal` QUIC client with `createIfMissing=false`, acknowledges
  handoff, and reports native status back to the webview. Default/clamped heights match macOS; use
  `keyboardLayoutGuide` so the prompt remains visible while the feed shrinks. Tests cover terminal
  request routing, constraints, keyboard-safe resizing, attach acknowledgement, and stale reconnect
  completions.
- [ ] R70. Wire explicit and involuntary iOS lifecycle separately. Back/context-ended, selecting
  another session, switching away from Agent, teardown, revoke, and user close issue immediate kill.
  Background suspension or transport loss detaches without explicit kill so the 30-second lease grace
  permits foreground reattach to the same PID; expiry creates a fresh resume next time. Reconnect uses
  generation checks so an old ready/attach task cannot bind to a newer session. Tests cover every
  transition, including Mac+iPhone final-lease behavior through manager integration.

## v5 Phase 6: automated integration and cleanup gates

- [ ] R71. Add an end-to-end temporary-socket smoke that starts the real `pty-manager`, launches a
  harmless command as a leased PTY through the coordinator, attaches two clients, drops them in order,
  verifies grace/reconnect PID preservation, then verifies final reap and no matching child process.
  Add harness command-construction smokes that use fixtures, not real user sessions. Run ATC webview
  tests, PTY Rust tests, Swift package tests, `just webview-smoke`, `just sim-test`, `git diff --check`,
  and `just check`. Review the complete cross-repo diff and confirm the only durable terminal owner is
  `pty-manager`.

## v5 Phase 7: explicit live feel verification

This phase is blocked on the repository's device/host launch checkpoint, not on implementation. State
the exact command and wait for the user to say `run it` before launching or reinstalling anything.

- [ ] R72. With approval, run the current Release host/client via
  `just fresh-release-diagnostic-run` and preserve attached client plus host logs. Verify an idle Claude
  session reaches its native resume UI (including the old-session summary choice), an idle Codex
  session restores its TUI, both accept keyboard input through SwiftTerm, the bottom pane resizes
  without covering the feed, and build SHAs match HEAD.
- [ ] R73. In the same approved run, verify lifecycle on the real surfaces: explicit close/back/session
  change/surface switch leaves no deterministic PTY; reconnect within grace keeps PID; grace expiry
  removes the PTY; Mac+iPhone dual attach survives the first detach and dies after the final detach;
  externally live sessions report `activeElsewhere`. Inspect the PTY Manager window and process table
  after every terminal path. Promote R58-R73 only when automated gates and this no-dangling-PTY read
  are both green.

## Promotion log

No v5 tasks promoted yet.
