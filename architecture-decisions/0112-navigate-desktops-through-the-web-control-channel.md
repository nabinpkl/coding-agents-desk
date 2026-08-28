---
status: accepted
date: 2026-08-27
---

# Navigate Desktops through the Web control channel

## Context and Problem Statement

The first-party Web desktop has TypeScript pointer and keyboard control but no Desktop or monitor
selector. Reusing the iOS switcher UI would make gesture and layout changes require another app
release. macOS Spaces enumeration, notifications, and Dock gesture injection still require native
capabilities. This decision concerns the Web desktop, not Desktop Park or a window picker.

## Decision Drivers

- Preserve the native tap/swipe mechanics while keeping iteration in live TypeScript.
- Bind capture and input to stable physical monitor identities, including during handover.
- Avoid thumbnail demand, continuous topology polling, and competing input controllers.

## Considered Options

- Native iOS switcher bridge: existing UI, but each behavioral change crosses the app-build boundary.
- A second HTTP/WebSocket navigation path: independently available, but splits ordering and ownership.
- The existing ordered `agentdesk-control-v2` channel with a thin standalone Spaces adapter.

## Decision Outcome

Use the existing control channel. `desktopNavigationVersion: 1` advertises the added capability;
missing support leaves video and existing control viewable with an explicit navigation warning.
TypeScript owns the compact numbered rail, monitor row, direction/expansion preferences, drag
arbitration, predicted selection, timeout, cancellation, and monitor handover. No thumbnails or
window enumeration are part of this surface.

The standalone capture helper owns SkyLight reads, per-display `Current Space`, AppKit/AX
notifications, and serial Dock events. The host and helper compile the same `DockSwipeEvent`
primitive. Space IDs remain decimal UInt64 strings end to end. A target tap addresses its exact
Space ID, independently of swipe-direction preference; intermediate fullscreen Spaces still count
in the physical Dock sequence. The helper runs a CFRunLoop so OS notifications actually arrive.
Mission Control exit detection reads Dock visibility only between an entry notification and exit.

An offer resolves the main alias or explicit stable display ID before encoder lookup. One physical
display has one encoder key. The browser pins that identity across reconnects. Monitor selection
warms a new keyed stream while retaining the old picture with input disabled, then retires the old
source after the matching generation presents its first frame. A removed monitor rehomes to the
remaining main display with a notice, either from a topology event or the next failed offer's
replacement identity. Ordinary Space changes never recreate the peer or reset viewport zoom.

Control ownership is Mac-wide across capture helpers, not one independently active owner per
monitor. Passive snapshots and refreshes do not acquire control. Only a gesture begin may acquire;
late changed/ended/cancelled messages from a revoked controller cannot reacquire. Release, teardown,
capture topology change, and signal termination cancel an unfinished native Dock gesture with phase 8.

### Consequences

- Good: future UI and gesture tuning needs no iOS or host app rebuild, install, or relaunch.
- Good: late join replays only cursor/topology state, never commands or switch results.
- Cost: handover briefly has two captures, and waits for real presentation rather than signaling.
- Risk: Dock gesture fields and AX Expose notifications are private OS contracts. Explicit failures,
  golden tests, and a separately approved physical acceptance pass remain necessary.
- Deployment: rebuild only the standalone helper and reopen the stream. No client version bump.

### Confirmation

Shared JSON fixtures exercise the Bun validator and injected Swift event poster. Tests cover exact
target IDs, fullscreen traversal, Dock phases/fields/location, malformed terminal phases, trust
denial, missing monitors, stale snapshots, target settlement, cancellation, monitor generations,
unplug recovery, and keyboard coexistence. TypeScript telemetry uses the existing allowlisted
`/webrtc/telemetry` route. No text or window content is recorded.

## Links

- [First-party WebView desktop control](../SPEC.md#first-party-webview-desktop-control)
- [ADR-0109](0109-own-web-desktop-control-in-typescript.md)
