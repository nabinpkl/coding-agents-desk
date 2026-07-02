# Three-Surface Control Switcher (Control | Agent | Browser)

Date: 2026-07-02
Status: design, pending implementation
Scope: iOS client only. No host or wire-protocol changes.

## Problem

The client's top switcher is a 2-segment `UISegmentedControl` with **Control**
(trackpad / display rail / keyboard, i.e. the desktop pixel/video path) and
**Agent** (`AgentFeedSurface` webview). The browser DOM-mirror surface
(`DomMirrorSurface`, ADR-0038/0042/0043/0044) already works, but it is **not**
part of the switcher: `render()`'s connected case eagerly shows it full-bleed
(`PairingViewController.swift:564`) whenever the session opened a `.dom` lane,
overlaying everything with no way to switch back to Control or Agent.

We want the browser to be a proper **third selectable surface** in the same
switcher: **Control | Agent | Browser**.

Explicitly out of scope (confirmed with user): any host-side "browser-only
session mode" that runs without the desktop capture pipeline. This is a pure
client-side switcher change over the *existing* browser-only DOM path.

## Approach

Generalize the existing 2-way toggle into an N-way surface switcher. The
`showAgent: Bool` binary becomes a `ControlSurface` enum; Browser reuses the
exact lazy-create + lane-wiring pattern Agent already uses.

Rejected alternatives:
- **Keep Browser full-bleed, add a "back to Control" button.** Leaves two
  different switching paradigms on one screen.
- **Always render 3 tabs, disable Browser when no `.dom` lane.** A dead tab
  clutters the default (browser-off) experience for every session.

## Design

### 1. Surface enum + testable visibility mapping

Replace the `showAgent: Bool` binary with:

```swift
enum ControlSurface { case control, agent, browser }
```

Extract the pure surface -> visibility mapping into a free function so it is
unit-testable without a live view controller (matches the codebase's
testable-seam convention):

```swift
struct SurfaceVisibility {
    let agentHidden: Bool
    let browserHidden: Bool
    let controlChromeHidden: Bool   // trackpad, rail, buttons, hints, scroll strip
    let keyboardInteractive: Bool
}

func visibility(for surface: ControlSurface) -> SurfaceVisibility
```

Mapping:

| surface  | agentHidden | browserHidden | controlChromeHidden | keyboardInteractive |
|----------|-------------|---------------|---------------------|---------------------|
| control  | true        | true          | false               | true                |
| agent    | false       | true          | true                | false               |
| browser  | true        | false         | true                | false               |

`applySurface(_:)` applies those flags to the concrete views (replaces
`applyAgentSurfaceVisibility(showAgent:)`).

### 2. Conditional segments

`showSurfaceToggleIfNeeded()` builds `["Control", "Agent"]` always, and appends
`"Browser"` **iff `pairingClient.activeDomMirror != nil`** at build time.
DOM-lane availability is fixed for a session's lifetime (decided at the
handshake), and the toggle is torn down + rebuilt on every non-connected state,
so reading availability once at build time is race-free.

### 3. Browser becomes lazy, like Agent

- Remove the eager full-bleed `ensureDomMirrorSurface()` call at
  `PairingViewController.swift:564`.
- Create the surface + start the `.dom` lane on **first Browser select**
  (via the existing `ensureDomMirrorSurface()`), not on connect. Also
  CPU-aligned: the browser mirror does not run unless viewed.
- Default selected segment is **Control** (index 0), regardless of whether a
  `.dom` lane is present (confirmed with user: consistent default over
  intent-based auto-select).

### 4. Teardown

`teardownAgentSurface()` (which also owns the segmented control) additionally
tears down the browser surface, so a reconnect rebuilds all three cleanly. The
`.dom` lane wiring is unchanged.

## Data flow / wire

Unchanged. The `.dom` lane, `onBatch`, and `onTap` wiring already exist. This
change only alters *when* the browser surface is created and shown, and adds a
third segment to the switcher.

## Edge cases

- **No `.dom` lane:** 2 segments, behaviour byte-identical to today.
- **Switch away from Browser (v1):** the lane stays alive once started (mirrors
  the hidden-but-alive Agent webview). Pausing the lane while hidden is a
  natural CPU follow-up, out of scope here.
- **Reconnect:** toggle torn down + rebuilt, re-reads DOM availability.

## Testing

- Unit-test `visibility(for:)` across all three surfaces (pure function, no view
  controller required). Wire the new test file into the xcodeproj (mirror a
  sibling test target's pbxproj entries per repo convention).
- `just check` green.
- Physical/simulator device run is the single human checkpoint per project
  device-session policy.

## Files touched (anticipated)

- `client/AgentDeskClient/PairingViewController+AgentSurface.swift` — enum,
  conditional 3rd segment, `applySurface(_:)`, segment handler, teardown.
- `client/AgentDeskClient/PairingViewController+DomMirror.swift` — lazy select
  entry point (already exists; wire to Browser select).
- `client/AgentDeskClient/PairingViewController.swift` — remove eager show at
  line 564.
- `client/AgentDeskClientTests/…` — new `visibility(for:)` unit test + pbxproj
  wiring.
