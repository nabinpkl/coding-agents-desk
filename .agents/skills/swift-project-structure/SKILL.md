---
name: swift-project-structure
description: Use when adding or changing shared host/client wire types, extracting duplicated Swift types into the AgentDeskWire SPM package, or adding/moving/converting files in the AgentDeskHost or AgentDeskClient Xcode projects. Both app projects are now buildable (synchronized) folders (objectVersion 70); this skill carries the wiring rules and the migration gotchas so a change does not silently break the build or a test.
---

# Swift Project Structure

The AgentDesk repo is three Swift build units: the `AgentDeskWire` local SPM package (`packages/AgentDeskWire`, the single source of truth for the host<->client wire contract, ADR-0050) and the two app projects (`host/AgentDeskHost.xcodeproj`, `client/AgentDeskClient.xcodeproj`). Both app projects use Xcode buildable/synchronized folders (`objectVersion = 70`, `PBXFileSystemSynchronizedRootGroup`). This skill is the operating manual for changing that structure without re-introducing the drift and wiring hazards it was built to remove.

## Adding a file (the easy case)

Both app source folders and both test folders are synchronized. **Drop a `.swift` file into `host/AgentDeskHost/`, `client/AgentDeskClient/`, or either `*Tests/` folder and it auto-compiles. Do not edit `project.pbxproj`.** Verify the sha is unchanged after a build if you want proof:

```sh
shasum host/AgentDeskHost.xcodeproj/project.pbxproj
```

The only pbxproj edits still needed by hand are linking a new SPM product (rare) and membership exceptions (below). Test files no longer silently go unrun: the folder is the target membership.

## Adding or changing a shared wire type

Shared types (anything both host and client send or decode) live in the package, never in an app. Put the type in the themed file under `packages/AgentDeskWire/Sources/AgentDeskWire/` (`Pairing`, `Session`, `OwnedMedia`, `OwnedGraphics`, `DomMirror`, `Input`, `DesktopState`, `UIFrames`, `AgentFeed`, `WireProtocol`, `Base64URL`, `Fingerprint`). Every consumer file already has `import AgentDeskWire`.

The `public` boundary has four cascading costs. Miss one and it fails to compile only from the other module:

- **`public` on the type AND every stored property, initializer, and method** used across the module boundary. `CodingKeys` can stay internal.
- **`Sendable`** on the type. A `public` value type does NOT get the implicit `Sendable` inference an `internal` one did; anything crossing a `@Sendable` closure or actor needs it explicitly. Add it to nested enums too (e.g. `NormalizedInput.ScrollPhase`).
- **A `public` memberwise init** if the type has no explicit init and is constructed outside the package. The synthesized memberwise init is `internal` and invisible cross-module. Same for a `public init()` on a struct with only private/defaulted stored props (parsers with a `private var buffer`).
- **Move the type's dependencies too.** A `Codable` conformance written as a separate `extension X: Codable` is a distinct declaration (do not mark the extension `public`, mark its members); a `private` helper struct the type uses; a utility like `Base64URL`. The compiler points at the type, not the missing dependency.

Protocol constants the wire types embed (`protocolVersion`, `sessionQuicALPN`) live in `WireProtocol`; each app's `Config` references `WireProtocol.*`, not a literal. Wire types must not read app `Config`.

Add a round-trip assertion to `packages/AgentDeskWire/Tests/AgentDeskWireTests/WireRoundTripTests.swift` (the single-source suite; per-app tests exercise the same types in context). `just check` runs the package tests first via the `wire-test` recipe.

## Extracting a cluster from an app into the package

If a type is duplicated across `host/.../*.swift` and `client/.../*.swift`, it should move to the package. Do it in behavior-preserving clusters, each its own commit, `just check` green between them:

1. Move the type text into the themed package file; apply the four `public` costs above.
2. Delete it from BOTH app copies in the SAME change (no duplicate-symbol window).
3. Reconcile drift as a UNION so neither side loses a field. Where host and client disagree on a method's thrown error or an init's argument order, pick one canonical shape and fix the call sites on the other side (this is the one place the move changes a code path, not just relocates a type).
4. Add `import AgentDeskWire` to any consumer that now references the moved type.

## Converting a group to a buildable folder (Xcode GUI only)

This is **not scriptable**. A hand-authored `objectVersion = 77` pbxproj builds the app but breaks the test target: the app target stops emitting an importable module when built as the test's dependency, so `@testable import AgentDeskHost` fails with `unable to resolve module dependency`. Xcode's own conversion wires the test-target module visibility (and the exception sets) correctly; a script cannot. Computer-use cannot do it either (Xcode is IDE-tier, right-click blocked).

To convert: **Project Navigator, right-click the group -> "Convert to Folder"**, on each of the four groups (host app+tests, client app+tests), then Cmd-S. Requirements and consequences:

- **The on-disk folder and the Xcode group must match exactly**, or Xcode refuses with "Content Missing From Group". This is a feature: it surfaces files on disk that were never wired into the project (dead, never-compiled code). Wire them in or delete them, then retry.
- **Resources are handled automatically.** `Assets.xcassets` compiles to `Assets.car`; `Info.plist` and `.entitlements` are excluded via auto-generated `PBXFileSystemSynchronizedBuildFileExceptionSet`s. The host's generated `atc-sidecar` dylib still bundles into `Contents/Resources` (it was preserved as an explicit member, not a folder-discovered file).
- Xcode assigns the app folder to BOTH the app and test targets, with the test target's exception set excluding the app sources. If an app file is NOT excluded (e.g. it was dual-target in the old project), a test that names one of its types gets a module-collision (`AppTests.T` vs `App.T`). Fix by adding that file to the test target's `membershipExceptions`.

## Verify

```sh
just check-all   # host build+tests + package tests + client sim tests
```

For a structure change specifically, also confirm the payoff and that nothing regressed silently:

- Drop a throwaway `.swift` into an app folder, build, confirm the pbxproj sha is unchanged, delete it.
- Confirm the host `.app` still contains `atc-sidecar`: `find <DerivedData>/.../AgentDeskHost.app -name atc-sidecar`.
