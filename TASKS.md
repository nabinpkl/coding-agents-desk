# TASKS: v-wire shared wire package + modern Xcode project format

`R<N>` = remaining. Flip to `D<N>` once landed and tests are green.

## Position

Scope this iteration: extract the ~79 shared wire types out of the two hand-mirrored `SharedTypes.swift` copies into a local Swift package `packages/AgentDeskWire`, then migrate both app projects to `objectVersion = 77` synchronized groups. Per ADR-0050. Order is ADR gate, then package seam, then cluster-by-cluster type moves, then delete the copies and consolidate tests, then the project-format migration last. Reasons:

- The ADR gates the mechanical move because the wire shapes are ADR-locked (ADR-0002/0020/0030/0048); it lands before any code.
- The empty package plus both app package-references land first (R2) so the linkage is proven before any type depends on it.
- Types move in clusters (R3-R5), each deleted from `SharedTypes.swift` in the same task so there is never a duplicate-symbol window, and each verified with `just check` so a break is localized to one cluster.
- Deleting the copies and consolidating round-trip tests (R6) comes only after every type has a package home.
- The `objectVersion = 77` migration (R7) is last because it is the least reversible step; it lands on a green `check-all` and behind the device-run checkpoint.

Reuse is load-bearing: the move is a relocation plus drift reconciliation, not a protocol revision. The existing per-side wire round-trip tests (`PairingTests`, `QuicSessionStreamFrameTests`, `MediaDatagramCarrierTests`, `PairingClientTests`, `InputChannelTests`, `OwnedMediaFrameRepairBufferTests`) are the safety net; their pure Codable assertions consolidate into `AgentDeskWireTests`.

## Phase 0: ADR (gate)

- [x] R1. ADR `architecture-decisions/0050-shared-wire-package-and-project-format.md` (accepted): local package, one target with themed files, `objectVersion = 77` adoption. Reference it from `SPEC.md` Module Boundaries. Open this ledger.

## Phase 1: introduce the package (seam, no wire-behavior change)

- [x] R2. Scaffold `packages/AgentDeskWire/` (`Package.swift` swift-tools 6.0, platforms macOS 26 / iOS 26, one library target + `AgentDeskWireTests`). Add the local package reference (`XCLocalSwiftPackageReference` relativePath `../../packages/AgentDeskWire`, `XCSwiftPackageProductDependency`, Frameworks phase + `packageProductDependencies`) to both app projects. Verify both apps build against the empty package.
- [x] R3. Move `WireProtocol` constants + `Fingerprint` + `Pairing` + `Session` clusters into the package as `public`; delete from both `SharedTypes.swift`; add `import AgentDeskWire`; repoint both `Config.protocolVersion`/`sessionQuicALPN` to `WireProtocol.*`. `just check`. Also moved `Base64URL` (a wire-type dependency) into the package; added `Sendable` to the moved value types (public loses implicit Sendable inference).
- [x] R4. Move `Input` + `DesktopState` + `UIFrames` + `AgentFeed` clusters (same recipe). `just check`.
- [x] R5. Move `OwnedMedia` + `OwnedGraphics` + `DomMirror` clusters with drift reconciliations (see below). Move host-only (`OwnedGraphicsAckWaiter`, `GraphicsBackpressure`, `GraphicsSendPacer`) and client-only (`OwnedGraphicsTransportError`, `OwnedGraphicsStreamRead`, `OwnedGraphicsResetFallback*`, `OwnedGraphicsQueueDepth`, `OwnedMediaRender*`, `OwnedMediaDisplayQueue*`) behavior types into new small app-side files. `just check`.
- [ ] R6. Delete both now-empty `SharedTypes.swift` and their pbxproj entries. Add `import AgentDeskWire` to the remaining consumers (19 host + 16 client). Consolidate pure wire round-trip assertions into `AgentDeskWireTests`; leave behavior tests app-side. `just check-all` green.

## Phase 2: modern project format (no manual UUID wiring)

Trigger: only after R6 is green, so the format change and the type move never tangle in one diff.

- [ ] R7. Migrate both app projects to `objectVersion = 77` with `PBXFileSystemSynchronizedRootGroup` for app and test source folders. Add `PBXFileSystemSynchronizedBuildFileExceptionSet` where a file must not compile into a target. Keep `Assets.xcassets`/`Info.plist`/`.entitlements` associations and the shared schemes intact. `just check-all`, then gated device install per AGENTS.md. Confirm a throwaway file compiles with no pbxproj edit.

## Drift reconciliation (union, behavior-preserving)

- `DomBatchEnvelope`: keep host's optional `emulated: Bool?` (ADR-0048).
- `OwnedSurfaceUpdateId`: conform `Hashable` + `Comparable`.
- `DomStatusEnvelope` (host) / `DomStatus` (client): unify to package `DomStatus`; update host call sites.
- `OwnedGraphicsFrameAck`: one canonical `init` signature (CodingKeys already match, wire unaffected).
- Graphics parsers throw the shared `SessionRejected(.malformed)`; the client transport layer maps it to its client-only `OwnedGraphicsTransportError` at the call site.
- Include host-only pure helpers (`wireByteCount`, `kindIsBitmapTile`, `kindIsReset`) in the package.

---

## Promotion log

```
R1       2026-07-03  committed   ADR-0050 drafted; TASKS opened; SPEC references the package
R2       2026-07-03  committed   scaffold package + link both app projects (app+test targets)
R3       2026-07-03  committed   move Pairing/Session/Fingerprint/WireProtocol + Base64URL; Config->WireProtocol; +Sendable
R4       2026-07-03  committed   move Input/DesktopState/UIFrames/AgentFeed clusters
R5       2026-07-03  committed   move OwnedMedia/OwnedGraphics/DomMirror; drift reconciled (emulated, Hashable, ack order, DomStatus, parser->SessionRejected)
R6       pending     pending     delete SharedTypes copies; consolidate wire tests
R7       pending     pending     objectVersion 77 synchronized-groups migration
```
