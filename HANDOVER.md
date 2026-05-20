# Handover

Snapshot of what landed and what is left, for the next session or the next pair of eyes. Read after `AGENTS.md`. Authoritative state lives in `PRD.md`, `SPEC.md`, the ADRs, and `TASKS.md`; this file points at them and adds only what those do not already say.

## Where v0 is

- ADR-0001 (stack and transport) accepted.
- ADR-0002 (pairing crypto) accepted.
- Phase 0 D0a, D1, D2, D3, D4, D5 landed. R6 is the only Phase 0 item left.
- Phase 1 (S1, #3) landed bundled with the Phase 0 sub-tasks: `Pairing` and `PairingClient` modules implement ADR-0002 verbatim, 10 Swift Testing tests green, `just check` exit 0.
- Phase 2 through 8 captured as one-liners in `TASKS.md`. Not started.

The signing pivot in `agent-memory/project_signing_pivot.md` is still in effect; Apple Developer Program enrollment is throttled as of 2026-05-20.

## What needs the human now

**R6 is HITL on-device launch verification.** No agent can do this; it needs you to run on real hardware and to reboot the Mac for the LaunchAgent survival check.

Both Xcode projects open when you read this. If not, run:

```
open host/AgentDeskHost.xcodeproj
open client/AgentDeskClient.xcodeproj
```

### Step 1. Build and run the host on the Mac

1. In the host project, select scheme `AgentDeskHost`, destination `My Mac`.
2. Cmd-R. The first build configures automatic free signing under your personal team.
3. Confirm the menu-bar icon appears (the `display` SF Symbol). Click it. The popover should show the idle state.
4. Take a screenshot of the menu bar with the AgentDesk icon visible. Save as `handover-screenshots/01-host-menubar-icon.png`.

### Step 2. Reboot survival test (this also closes R5's reboot leg)

1. Quit the host (right-click menu bar icon, or use the popover if you wired a Quit button).
2. Reboot the Mac via the Apple menu.
3. Log back in.
4. Wait ~5 seconds. The menu-bar icon should reappear without you touching the app, because the LaunchAgent installed on first launch in Step 1.
5. If the icon does not reappear, run `launchctl list com.example.agentdesk.AgentDeskHost` and `cat ~/Library/LaunchAgents/com.example.agentdesk.AgentDeskHost.plist` to diagnose, and surface the output as an issue.
6. Take a screenshot of the post-reboot menu bar. Save as `handover-screenshots/02-host-menubar-after-reboot.png`.

### Step 3. Build and run the client on the iPhone

1. Connect your iPhone via USB or wireless pairing. Trust the computer if prompted.
2. In the client project, select scheme `AgentDeskClient`, destination your physical iPhone.
3. Cmd-R. Xcode will provision a free 7-day developer profile under your personal team. Tap the dev profile through to trust if iOS asks.
4. The app should launch and show the placeholder pairing view.
5. Take a screenshot on the iPhone (volume-up + side-button). AirDrop or sync it to your Mac. Save as `handover-screenshots/03-client-placeholder.png`.

### Step 4. Close R6

When all three screenshots are in `handover-screenshots/`, commit them and the updated HANDOVER.md, then flip R6 to D6 in `TASKS.md`.

If any step fails, do not flip R6. Surface what failed and where; the failure is informative.

## What was deliberately not done in this iteration

- libwebrtc integration. The S1 pairing handshake uses a plain WebSocket; libwebrtc enters in S2.
- ScreenCaptureKit, VideoToolbox, and any input dispatch. S2 through S6.
- Spaces enumeration via private CGS, and the 3-finger swipe. S5.
- LaunchAgent uses raw plist plus `launchctl bootstrap`, not `SMAppService`. The latter requires entitlements that conflict with the Xcode free signing the project uses during the Apple Developer Program throttle window.

## Cross-references

- Operating rules: `AGENTS.md`.
- Product intent: `PRD.md`.
- Technical shape: `SPEC.md`.
- Locked decisions: `architecture-decisions/0001-stack-and-transport.md`, `architecture-decisions/0002-pairing-crypto.md`.
- Iteration ledger: `TASKS.md`.
- Signing pivot: `agent-memory/project_signing_pivot.md`.
