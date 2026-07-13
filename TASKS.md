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

- ADR-0056 fixes the lifecycle and ownership contract before protocol or UI code lands (L0).
- The PTY protocol gains explicit launch and lifetime semantics before either app asks it to resume a
  harness (L1 before L2/L4-L6). Input injection into a shell is not an intermediate path.
- The host coordinator owns harness command construction and deduplication before platform UI joins,
  because GUI-launched processes do not have a reliable shell `PATH` and two opens must not create two
  resume processes (L2 before L3/L5/L6).
- The authored Agent Panel webview in the ATC sibling emits session-scoped open/close intent only;
  native containers own SwiftTerm and layout (L3 before L5/L6).
- Shared SwiftTerm extraction is a separate lane from webview intent and can run alongside L2 once the
  PTY contract lands (L4 after L1); this keeps React/bridge and terminal-renderer ownership distinct.
- macOS and iOS consume the same coordinator contract and shared SwiftTerm content, but keep their
  platform layout/lifecycle adapters in parallel lanes (L5 and L6 after L2-L4).
- Automated lifecycle gates land before preapproved live-surface drives. Phase 7 uses the isolated dev
  host plus iPhone Simulator, so it can run autonomously without touching the stable host or a physical
  device (L7 after L5/L6).

## Execution lanes

The Co-ordinator opens one standing Implementor task and one standing Reviewer task per lane, then
records their Codex task IDs in this table immediately. The same pair owns every R-task in that lane,
including correction and re-review rounds. `not opened` is an execution state, not permission to spawn
one task per R-task. After context compaction, this table is the source of truth for which tasks to
resume.

| Lane | Owned surface | R-tasks | Starts after | Implementor task | Reviewer task | State |
| --- | --- | --- | --- | --- | --- | --- |
| L0 Decision | ADR/SPEC compatibility contract | D58 | none | `019f59b0-7e57-72c3-b81c-30f862200e61` | `019f59b0-823e-70f3-a4d2-50fb7bfb63aa` | complete |
| L1 PTY core | PTY protocol, Rust manager, Swift bindings | R59-R61 | L0 | not opened | not opened | queued |
| L2 Host control | resume identity, coordinator, AgentDesk wire | R62-R64 | L1 | not opened | not opened | queued |
| L3 Panel intent | ATC webview and native bridge intent | R65 | L2 | not opened | not opened | queued |
| L4 Terminal content | shared SwiftTerm content and existing consumers | R66 | L1 | not opened | not opened | queued |
| L5 macOS | Agent window layout and macOS lifecycle | R67-R68 | L2, L3, L4 | not opened | not opened | queued |
| L6 iOS | Agent surface layout, transport, and iOS lifecycle | R69-R70 | L2, L3, L4 | not opened | not opened | queued |
| L7 Verification | integration smoke, simulator, macOS AX, orphan audit | R71-R73 | L5, L6 | not opened | not opened | queued |

The Co-ordinator may run lanes in parallel only when the dependency column is satisfied and file
ownership does not overlap. L3 and L4 may run in parallel; L5 and L6 may run in parallel. Contract
changes discovered inside a consumer lane return to the producing lane and land there before dependent
work resumes. A standing task is replaced only when unavailable, near its context limit, or stale; the
replacement task ID and handoff state are written into this table before work continues.

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

## v5 Phase 0: decision and compatibility gate (L0)

No behavior code lands until the lifecycle owner, protocol boundary, and compatibility consequence are
recorded.

- [x] D58. Add and accept ADR-0056 for the bottom Agent Panel terminal. Record: native SwiftTerm
  composition; deterministic per-harness-session identity; direct argv launch; `persistent` versus
  `leased` PTY lifetime; final-lease reaping; explicit-close semantics; active-elsewhere rejection;
  host-owned command construction; and the macOS/iOS ownership split. Update `SPEC.md` with the new
  Agent Panel terminal flow, PTY v4 inner protocol, and AgentDesk session protocol v7 requirement.
  Test/verification: ADR index is consistent, accepted ADRs remain untouched, and `rg` finds no
  conflicting description that says all PTYs survive detach.

## v5 Phase 1: explicit PTY launch and leased lifetime (L1)

This phase changes the in-tree PTY pair in lockstep. It does not add an Agent Panel UI.

- [ ] R59. Replace the v1 `CreateOrAttach.shell` shape in `terminal/pty-manager/proto/pty.proto` with
  an explicit launch oneof (`ShellLaunch` or `CommandLaunch { executable, arguments }`) plus
  `SessionLifetime { persistent, leased }`; include lifetime in session summaries. Bump the inner PTY
  protocol from v3 to v4 and regenerate both Rust and Swift bindings. Update every existing caller to request
  `persistent + ShellLaunch` explicitly; no v3 compatibility shim. Tests: Rust protocol round trips
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

## v5 Phase 2: one host-owned harness terminal coordinator (L2)

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

### L3: Panel intent

- [ ] R65. Extend `AgentPanelRequest` and the ATC `WebkitHostBridge` contract with session-scoped
  terminal open/close/context-ended intent. In `dashboard/webview/App.tsx`, add a fixed bottom launcher
  on the thread view only: terminal icon plus `Open Claude` or `Open Codex`. Opening enters a loading
  state; native ready/error/ended events update the bar. Back navigation, session replacement, and
  `pagehide` emit context-ended before leaving. Tests: project/session lists have no terminal action;
  the thread request carries the exact project/source/session; back closes before navigation; stale
  ready events cannot reopen a terminal for another session.

### L4: Shared terminal content

- [ ] R66. Extract the reusable SwiftTerm content from the existing iOS `TerminalPaneView` and macOS
  `SwiftTermPtyManagerTerminalWindow` into the existing `PtyTerminalSwiftTerm` product. It owns
  TerminalView input delegation, paste/bracketed-paste, output feeding, focus, PTY driver, and resize;
  platform containers supply chrome and constraints. Rewire the current full-screen iOS Terminal and
  macOS terminal window to consume it before Agent Panel does. Tests preserve current paste, input,
  output, resize, and detach behavior; no second terminal input implementation appears in AgentPanel
  or React.

## v5 Phase 4: macOS bottom terminal (L5)

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

## v5 Phase 5: iOS bottom terminal (L6)

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

## v5 Phase 6: automated integration and cleanup gates (L7)

- [ ] R71. Add an end-to-end temporary-socket smoke that starts the real `pty-manager`, launches a
  harmless command as a leased PTY through the coordinator, attaches two clients, drops them in order,
  verifies grace/reconnect PID preservation, then verifies final reap and no matching child process.
  Add harness command-construction smokes that use fixtures, not real user sessions. Run ATC webview
  tests, PTY Rust tests, Swift package tests, `just webview-smoke`, `just sim-test`, `git diff --check`,
  and `just check`. Review the complete cross-repo diff and confirm the only durable terminal owner is
  `pty-manager`.

## v5 Phase 7: autonomous simulator and macOS AX verification (L7)

Standing authorization for R72-R73: build, install, relaunch, and drive the isolated dev host and
iPhone Simulator without asking for another `run it`. This authorization includes identifier-based
macOS Accessibility actions and app-window screenshots. It excludes the stable host, physical iPhone,
coordinate clicks, pointer capture, and whole-screen screenshots; those retain the repository's normal
human checkpoint.

- [ ] R72. Add a Maestro Agent Panel terminal flow and make `just ui-flow` accept the dev simulator
  variant. Run `just agent-feed-sim-pair-dev`, confirm the dev host and simulator client build SHAs
  match HEAD, then drive the flow with `just ui-flow agent-terminal-smoke dev`. Verify idle Claude and
  Codex sessions reach their native resume TUIs, SwiftTerm accepts input, the bottom pane resizes
  without covering the feed, back/session change/surface switch kills the deterministic PTY, reconnect
  within grace preserves PID, and grace expiry removes it. Preserve simulator screenshots plus bounded
  host/client logs, and inspect the PTY Manager/process table after every terminal exit path.
- [ ] R73. Add or extend a repo-local macOS AX driver that resolves the dev host by bundle id and uses
  AX identifiers only. Relaunch the dev host as needed without further approval, verify its build SHA,
  open Agents, select idle Claude and Codex sessions, open each bottom terminal, exercise focus/input/
  resize/close, and capture only the Agent window. Verify hide, close, back, session change, harness
  natural exit, and grace expiry leave no deterministic PTY. Attach the simulator and Mac to one PTY
  to prove the first detach preserves the PID and the final detach reaps it; verify externally live
  sessions report `activeElsewhere`. Promote R58-R73 only when R71, both live drives, and the final
  no-dangling-PTY process-table read are green.

## Promotion log

| ID | Date | Status | Summary |
| --- | --- | --- | --- |
| D58 | 2026-07-13 | landed | ADR-0056 and `SPEC.md` lock leased Agent Panel terminals and the PTY v4 and AgentDesk v7 targets. |
