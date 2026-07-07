---
status: accepted
date: 2026-07-06
---

# Remote SwiftTerm terminal over the Agent Workspace IDE PTY multiplexer

## Context and Problem Statement

AgentDesk needs an iPhone terminal surface that displays in the client but executes on the Mac host. Agent Workspace IDE already has a Rust `pty-manager` that owns host PTYs, exposes a length-prefixed Unix-socket protocol, supports multiple clients per session, and has a Swift `PtyClientSwift` package plus a SwiftTerm desktop renderer. The decision is where terminal execution, multiplexing, and rendering responsibilities live across AgentDesk host, AgentDesk iOS, Agent Workspace IDE Rust, and the QUIC session.

## Decision Drivers

- Host execution must stay on the Mac; the iOS app must never spawn local shells for the host workspace.
- One PTY session must support multiple clients, including the iOS SwiftTerm renderer and a future host-local renderer attached to the same session.
- Terminal traffic must be reliable and ordered, but isolated from video datagrams, input events, DOM mirror traffic, and agent-feed messages.
- AgentDesk should not fork or reinterpret the PTY protocol when Agent Workspace IDE already owns it.

## Considered Options

- **Option A**: AgentDesk host launches Agent Workspace IDE's Rust `pty-manager`; iOS uses `PtyClientSwift` and SwiftTerm over a dedicated reliable `.terminal` QUIC stream; host bridges opaque PTY frames between QUIC and the manager Unix socket.
- **Option B**: Implement a new AgentDesk-native PTY service and protocol in Swift on the host.
- **Option C**: Run a shell or terminal engine inside the iOS client and remote only command text/output through AgentDesk.

## Decision Outcome

Chose **Option A** because it preserves the existing multiplexer model and keeps execution ownership clean. The Rust manager owns process lifecycle, session attach/detach, resize, input, output, session metadata, and future multi-client behavior. The iOS app owns only rendering and user input through SwiftTerm. AgentDesk host owns only process supervision and byte bridging. Option B duplicates a harder subsystem and would need to recreate multiplexer semantics. Option C violates the host-execution requirement and cannot represent a real host PTY.

For v0, the authenticated paired device is the terminal trust boundary. AgentDesk deliberately forwards the full `pty-manager` protocol instead of filtering it down to attach/input/resize, so the iOS SwiftTerm renderer is a normal trusted multiplexer client. Narrower per-command authorization can be added later if terminal controls become multi-tenant or user-facing kill/session management needs a different policy.

### Consequences

- Good, because iOS SwiftTerm and a future host-local renderer can attach as peer clients to the same PTY session.
- Good, because AgentDesk's QUIC model gains one new stream role, `.terminal = 5`, without mixing terminal bytes into media, input, DOM, or agent-feed lanes.
- Bad, because AgentDesk now has a runtime dependency on a generated Rust binary from the sibling Agent Workspace IDE checkout.
- Bad, because a paired terminal client currently has full PTY manager authority, not a reduced attach-only capability.
- Neutral, because protocol version moves to 5; older builds are rejected by the normal handshake compatibility path.

### Confirmation

`QuicSessionStreamRole.terminal.rawValue == 5` is pinned in host and client tests. `just build-pty-manager` builds and copies the Rust manager into the host app resource path; `just check` creates a placeholder so fresh checkouts build without tracking the binary. Client project dependencies mirror the existing Agent Workspace IDE terminal emulator: `PtyClientSwift` from the sibling checkout and SwiftTerm from `https://github.com/migueldeicaza/SwiftTerm.git` starting at `1.13.0`.

## Pros and Cons of the Options

### Option A

- Good, because it reuses the proven PTY execution and multiplexer code already built for Agent Workspace IDE.
- Good, because the AgentDesk host can stay a transport bridge instead of becoming a terminal protocol implementation.
- Bad, because the sibling checkout path and Rust build become part of local development setup.

### Option B

- Good, because all code would live in AgentDesk.
- Bad, because it recreates session multiplexing, PTY process management, protocol generation, and Swift client bindings that already exist.

### Option C

- Good, because it would be simplest to render locally.
- Bad, because it does not execute in the host environment and cannot satisfy workspace-terminal semantics.

## Links

- SPEC "Module Boundaries" and "Wire Shapes"
- ADR-0020 Wire protocol version negotiated at the session handshake
- ADR-0030 Single QUIC session transport for v0
- ADR-0050 Shared wire types as a local Swift package, and modern synchronized Xcode project format
- Agent Workspace IDE `terminal/pty-manager`, `terminal/pty-client-swift`, and `terminal/emulator`
