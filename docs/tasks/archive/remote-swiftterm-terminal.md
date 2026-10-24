# TASKS: v1 remote SwiftTerm terminal over host PTY multiplexer (with v2 terminal UX captured)

`R<N>` = remaining. Flip to `D<N>` once landed and tests are green.

## Position

v1 implements the terminal as a new client surface over the existing session transport, not as a separate app, side channel, or new PTY engine. Ordering:

- Wire role and ADR first, because host/client routing must agree before UI or process supervision can be meaningful.
- Host PTY manager bridge second, because the iOS terminal must execute on the Mac and attach to the multiplexer.
- iOS SwiftTerm surface third, because rendering depends on the dedicated QUIC terminal stream and `PtyClientSwift`.
- Build and docs last, because the Rust binary and Swift packages are generated/runtime dependencies that need explicit recipes and lockfiles.

## v1 Phase 0: readiness and decision record

- [x] D1. Define ADR `architecture-decisions/0051-remote-swiftterm-terminal-over-pty-multiplexer.md` selecting Agent Workspace IDE `pty-manager` as the host execution and multiplexer engine.
- [x] D2. Update `SPEC.md` to protocol version 5, stream role `.terminal = 5`, and host/client module boundaries for terminal process supervision, byte bridging, and SwiftTerm rendering.

## v1 Phase 1: shared wire seam

- [x] D3. Move `QuicSessionStreamRole`, `QuicSessionStreamFrame`, and frame helpers into `packages/AgentDeskWire/Sources/AgentDeskWire/QuicStreamFrame.swift` so host and client use one stream-role contract.
- [x] D4. Pin terminal role and protocol version 5 in `packages/AgentDeskWire/Tests/AgentDeskWireTests/WireRoundTripTests.swift`, `host/AgentDeskHostTests/QuicSessionStreamFrameTests.swift`, and `client/AgentDeskClientTests/InputChannelTests.swift`.

## v1 Phase 2: host PTY bridge

- [x] D5. Add `host/AgentDeskHost/HostPtyManagerProcess.swift` to launch the bundled Rust `pty-manager` against `Config.ptyManagerSocketURL`.
- [x] D6. Add `host/AgentDeskHost/TerminalClientBridge.swift` to bridge opaque length-prefixed PTY frames between `.terminal` QUIC streams and the manager Unix socket.
- [x] D7. Wire `host/AgentDeskHost/PairingSignalingServer.swift` and `host/AgentDeskHost/AppDelegate.swift` so authenticated terminal streams create retained bridges and unauthenticated streams receive `SessionRejected`.

## v1 Phase 3: iOS SwiftTerm client

- [x] D8. Add `client/AgentDeskClient/TerminalQuicPtyTransport.swift` and `client/AgentDeskClient/TerminalSurface.swift` so the iOS client opens a `.terminal` stream, wraps it in `PtyClientSwift`, and renders through SwiftTerm.
- [x] D9. Extend `client/AgentDeskClient/ControlSurface.swift` and `client/AgentDeskClient/PairingViewController+AgentSurface.swift` so Terminal is a lazy full-bleed surface beside Control, Agent, and Browser.

## v1 Phase 4: build and dependency wiring

- [x] D10. Extend `client/AgentDeskClient.xcodeproj` with local `PtyClientSwift` and remote SwiftTerm `1.13.0` package products and commit the project `Package.resolved`.
- [x] D11. Extend `Justfile` and `.gitignore` with `build-pty-manager`, `ensure-pty-manager-placeholder`, and the ignored `host/AgentDeskHost/pty-manager` bundle resource.
- [x] D12. Update Agent Workspace IDE `terminal/pty-client-swift/Package.swift` to allow iOS and `terminal/pty-manager/src/pty_manager_client_sessions.rs` to default empty cwd/shell to the host home/default shell.
- [x] D13. Harden review findings by making PTY manager shutdown bounded, making bridge cancellation close its Unix socket, synchronizing terminal transport close with QUIC FIN, scoping host-run port cleanup, and making `terminal-smoke` rebuild/reinstall before driving.

---

## v2 scope (captured, not started until v1 is exercised on device)

| Option | Source | What it catches | Failure shape |
| ------ | ------ | --------------- | ------------- |
| Host-local terminal client attach | Agent Workspace IDE multiplexer | Confirms the same `agentdesk-home` session can be rendered by Mac and iPhone clients concurrently | Requires a host UI attachment surface and session picker |
| Terminal session picker | `PtyClientSwift.listSessions()` | Lets the iOS client attach to multiple named host sessions instead of hardcoding `agentdesk-home` | Adds navigation/state before v1 proves the transport |
| Explicit kill/session controls | `pty-manager` kill and detach messages | Lets the user intentionally terminate a host PTY rather than only detach the iOS client | Dangerous if exposed before session ownership UX is clear |

### Alternative arc (rejected for now, captured)

- AgentDesk-native Swift PTY manager. Useful because all terminal code would live in one repo. Rejected because it duplicates an existing Rust multiplexer and weakens the model where SwiftTerm is just one client of a host-owned session. Revisit only if the sibling `pty-manager` becomes impossible to package or sign.

---

## Promotion log

```
D1-D12   2026-07-06  verified   remote SwiftTerm terminal lane implemented, host/client builds verified, no device launch performed
D13      2026-07-07  verified   terminal security/lifecycle review followups implemented; simulator smoke rebuild path required before OCR assertion
```
