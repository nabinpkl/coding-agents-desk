---
status: accepted
date: 2026-07-10
supersedes: ADR-0051
---

# AgentDesk owns the terminal PTY packages

## Context and Problem Statement

ADR-0051 chose to reuse Agent Workspace IDE's Rust `pty-manager` and `pty-client-swift` packages from the sibling checkout, and explicitly accepted "a runtime dependency on a generated Rust binary from the sibling Agent Workspace IDE checkout" and "the sibling checkout path and Rust build become part of local development setup" as consequences. ADR-0052 then decided AgentDesk absorbs the workspace and retires `agent-workspace-ide`, with acceptance criterion "No production AgentDesk target imports a source package from `agent-workspace-ide` after donor retirement." Those two positions conflict: the terminal packages were the last build/source dependency still pointing at the donor, so the donor could not be retired while ADR-0051's sibling-checkout arrangement stood.

## Decision Drivers

- ADR-0052's donor retirement requires no AgentDesk target to build or import source from `agent-workspace-ide`.
- The terminal architecture chosen in ADR-0051 is sound and should not change; only the package home should.
- The two packages are self-contained: the Rust `pty-manager` compiles its own `proto/pty.proto` with a vendored protoc, and `pty-client-swift` ships pre-generated protobuf and depends only on upstream SwiftTerm and SwiftProtobuf.

## Considered Options

- **Option A**: Copy `pty-manager` and `pty-client-swift` into AgentDesk-owned paths under `terminal/`, and repoint the two references (the Justfile `pty_manager_dir` and the client Xcode local package reference) at them.
- **Option B**: Keep the packages in the sibling checkout and leave ADR-0052's retirement criterion unmet.
- **Option C**: Publish the packages to a separate shared repository that both apps depend on.

## Decision Outcome

Chose **Option A**. The Rust `pty-manager` crate now lives at `terminal/pty-manager` and the `pty-client-swift` SPM package at `terminal/pty-client-swift`, both AgentDesk-owned. The **terminal architecture from ADR-0051 is retained unchanged**: the Rust manager owns process lifecycle, session attach/detach, resize, and multi-client behavior; the iOS app renders and takes input through SwiftTerm; the AgentDesk host bridges opaque PTY frames between the reliable `.terminal = 5` QUIC stream and the manager Unix socket. The only thing this ADR changes is **where the packages live**. Option B leaves a sibling-checkout build dependency and blocks donor retirement. Option C reintroduces a second lifecycle owner for shared code, which is the exact fragmentation ADR-0052 set out to remove.

### Consequences

- Good, because AgentDesk builds are self-contained: no sibling checkout is needed for `just build-pty-manager` or the client terminal packages, which unblocks the ADR-0052 donor retirement.
- Good, because the proven multiplexer, protocol, and SwiftTerm renderer move verbatim; there is no reimplementation risk.
- Neutral, because `agent-workspace-ide` is now tombstoned: its terminal source is preserved in history there and re-homed here.
- Neutral, because the one-time first-launch import of the donor's `~/Library/Application Support/agent-workspace-ide/workspace.json` (ADR-0052) is a runtime data-migration read, not a source/build dependency, and is deliberately retained until the migration window closes.

### Confirmation

`just build-pty-manager` compiles `terminal/pty-manager` and stages the binary into the host app resource path; `just sim-test` builds the client against `terminal/pty-client-swift` (`PtyClientSwift`, `PtyTerminalSession`, `PtyTerminalSwiftTerm`) plus upstream SwiftTerm; `just check` stays green. No `agent-workspace-ide` reference remains in `client/AgentDeskClient.xcodeproj`. The `.terminal = 5` role assertions from ADR-0051 are unchanged and still pinned in host and client tests.

## Links

- Supersedes ADR-0051 Remote SwiftTerm terminal over the Agent Workspace IDE PTY multiplexer (architecture retained; package home moved)
- ADR-0052 AgentDesk owns the agent workspace (donor retirement)
- SPEC "Module Boundaries" and "Wire Shapes"
- `terminal/pty-manager`, `terminal/pty-client-swift`
