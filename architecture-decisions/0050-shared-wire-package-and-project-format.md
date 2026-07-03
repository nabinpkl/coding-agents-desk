---
status: accepted
date: 2026-07-03
---

# Shared wire types as a local Swift package, and modern synchronized Xcode project format

## Context

The macOS host and iOS client are two independent `.xcodeproj` apps with no shared Swift module. The wire contract lives twice: `host/AgentDeskHost/SharedTypes.swift` and `client/AgentDeskClient/SharedTypes.swift` hand-mirror ~79 protocol types (pairing, session, owned-media, retained-graphics, input, DOM-mirror, agent-feed). Every wire change must edit both copies, and they have already drifted: the host added an `emulated` field to `DomBatchEnvelope` (ADR-0048) the client cannot decode, `OwnedSurfaceUpdateId` is `Hashable` on the host but not the client, the two graphics parsers throw different error types, and `DomStatusEnvelope` (host) and `DomStatus` (client) are the same wire shape under two names. The only guard is per-side round-trip tests that catch drift at test time rather than prevent it at compile time.

Separately, both projects are `objectVersion = 56` with classic groups. Every source and test file needs three-part UUID wiring (`PBXFileReference` + `PBXBuildFile` + `PBXSourcesBuildPhase` membership); an unwired test file silently never compiles into its target and never runs. Toolchain is Xcode 26.5 / Swift 6.3.2, so both local SPM packages and `objectVersion = 77` synchronized file-system groups are available and unused.

## Decision Drivers

- Single source of truth for the wire contract: drift must become a compile error, not a test-time surprise.
- No god file: the extracted module must be split along cohesive protocol areas.
- Remove the manual-UUID-wiring failure mode where a new file silently does not build.
- Behavior preservation: the wire bytes and Codable output must not change; this is a relocation plus a drift-reconciliation, not a protocol revision.

## Considered Options

- **Option A**: Local SPM package `AgentDeskWire`, one library target, themed source files, referenced by both apps; then migrate both app projects to `objectVersion = 77` synchronized groups.
- **Option B**: Local SPM package split into several sub-targets (one module per protocol area) for compiler-enforced boundaries.
- **Option C**: Keep the duplicated files; add a `just` drift check that diffs the two definitions and fails on mismatch.

## Decision Outcome

Chose **Option A**. It is the only option that makes drift structurally impossible (there is one definition), which Option C does not: a diff check still permits two files and only narrows the detection window. Option B was rejected on the no-ceremony driver: multiple targets multiply the `public` surface and force the apps to import several modules to gain no protection Option A lacks, since the wire types are one cohesive contract, not independent libraries. Cohesion inside Option A is achieved with themed files (`Pairing.swift`, `Session.swift`, `OwnedMedia.swift`, `OwnedGraphics.swift`, `DomMirror.swift`, `Input.swift`, `DesktopState.swift`, `UIFrames.swift`, `AgentFeed.swift`, plus `WireProtocol.swift` for the shared constants), so "no god file" is satisfied without target ceremony. The `objectVersion = 77` migration rides the same effort because the manual-wiring friction is the same root cause (two hand-maintained projects) and the fix is available in the current toolchain.

Side-specific behavior types (host graphics pacing/backpressure, client render and transport state) stay in their app targets; the package holds only the cross-side wire shapes plus the encode/decode/sign logic that is genuinely identical. Drift is reconciled as a union so no side loses a field. The two protocol constants the wire types read from `Config` (`protocolVersion`, `sessionQuicALPN`) move into the package as canonical constants, and each app's `Config` references them, so the constants also become single-source.

### Consequences

- Good, because a wire change is one edit against one definition, and a divergence between host and client expectations fails to compile.
- Good, because new host/client source files compile with zero pbxproj edits after the synchronized-groups migration, closing the silent-unwired-test-file hole.
- Bad, because every shared type, initializer, member, and `CodingKeys` must become `public`, a large mechanical diff.
- Neutral, because the app shells stay `.xcodeproj`; only the shared code gains folder-based source discovery (via SPM) and the app folders gain it via synchronized groups.

### Confirmation

`just check` and `just check-all` stay green across the extraction, with the wire round-trip assertions consolidated into `AgentDeskWireTests` (tested once) proving Codable output is unchanged. After the `objectVersion = 77` migration, a throwaway file dropped into each app source folder compiles with no project-file edit. The compiler itself is the ongoing fitness function: a future host-only field on a shared type will not build the client until the client agrees.

## Links

- SPEC "Module Boundaries" and "Wire Shapes"
- ADR-0002 (pairing crypto wire shapes), ADR-0020 / ADR-0030 (protocol version and session transport), ADR-0048 (the `emulated` field that drifted)
- TASKS.md (this iteration's R1-R7 ledger)
