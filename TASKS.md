# TASKS: v0 daily-driver replacement of AnyDesk (S0 active, S1 through S8 captured)

`R<N>` is remaining. Flip to `D<N>` once landed and verification passes. Numbers are stable; retire dropped IDs in the promotion log, never reuse.

## Position

v0 is one iteration. Acceptance is the author using AgentDesk as a daily driver for 7 consecutive days without reaching for AnyDesk (per `PRD.md`). The iteration is sliced into nine vertical phases that mirror GitHub issues #2 through #10:

- Phase 0 (S0, #2): bootstrap. ADR-0001, Xcode projects, signing, LaunchAgent. No product behavior.
- Phase 1 (S1, #3): QR pairing end-to-end.
- Phase 2 (S2, #4): hello-pixels.
- Phase 3 (S3, #5): cursor and basic click.
- Phase 4 (S4, #6): full trackpad gestures.
- Phase 5 (S5, #7): Spaces enumeration and 3-finger swipe.
- Phase 6 (S6, #8): keyboard and accessory row.
- Phase 7 (S7, #9): lifecycle and reconnect.
- Phase 8 (S8, #10): distribution and 7-day self-test.

Phase 0 is the gate. Nothing else lands until ADR-0001 is committed and both Xcode projects build clean. Phase 1 (pairing) ships before Phase 2 (pixels) because pixels require a connected WebRTC peer and a verified `SessionToken`, both produced by pairing. Phase 5 (Spaces) ships after Phase 4 (gestures) because the 3-finger swipe is a gesture, so the gesture vocabulary must exist first. Phase 7 (lifecycle) ships before Phase 8 (distribution) because the 7-day daily-driver test in Phase 8 cannot start until foreground reconnect is reliable.

Signing pivot for Phase 0: Apple Developer Program enrollment is throttled (~48hr+ from 2026-05-20), so Phase 0 uses Xcode automatic free signing per `agent-memory/project_signing_pivot.md`. Developer ID notarized DMG and TestFlight upload acceptance items fold into Phase 8 when the paid cert lands. The free 7-day provisioning profile reinstall cadence is operational overhead during the throttle window; if it persists into the 7-day daily-driver test, it becomes a real risk for Phase 8 acceptance.

Authoritative dependency edges for each phase live in the issue's "Blocked by" section, not here.

## v0 Phase 0: bootstrap (S0, #2). Gate.

Phase goal: lock the stack in an ADR, scaffold both Xcode projects with free signing, confirm both apps launch on real hardware. No product behavior.

- [x] D0a. Write `architecture-decisions/0001-stack-and-transport.md`. Captures the locked decisions from `SPEC.md`: native Swift on both ends, libwebrtc via SPM, ScreenCaptureKit + VideoToolbox HEVC on host, `AVSampleBufferDisplayLayer` on client at native DPR, Tailscale-only network, QR + Keychain pairing, primary-display-only capture in UI but multi-display-aware in protocol, drop-on-background lifecycle, paid Apple Developer Program distribution. Status `accepted`. Cross-link from `SPEC.md` by ADR number, not by path. ADR-0002 (`pairing crypto for v0`) landed in the same change as a Phase 1 prerequisite; both are indexed in `architecture-decisions/README.md`.
- [x] D1. Scaffold macOS host Xcode project at `host/AgentDeskHost.xcodeproj`. Menu bar app via `NSStatusItem` with placeholder popover. Bundle ID `com.example.agentdesk.AgentDeskHost`. Landed bundled with R7 in a single Codex turn because the project skeleton is not independently verifiable without a build target.
- [x] D2. Scaffold iOS client Xcode project at `client/AgentDeskClient.xcodeproj`. UIKit, placeholder `PairingViewController`. Bundle ID `com.example.agentdesk.AgentDeskClient`. Landed bundled with R7.
- [x] D3. Add `Justfile` at repo root. `just check` drives `xcodebuild build test` on both targets. iOS test destination is configurable via `AGENTDESK_IOS_TEST_DESTINATION` env var, default `platform=iOS Simulator,name=iPhone 17,OS=latest`. `just dev` opens both Xcode projects.
- [x] D4. Configure Xcode automatic free signing on both projects per `agent-memory/project_signing_pivot.md`. Both targets build clean against the developer's local cert; on-device install via Xcode Run will use the personal team when the user runs it. No App Store provisioning, no Developer ID, no TestFlight.
- [ ] R5. Register macOS host LaunchAgent plist at `~/Library/LaunchAgents/com.<placeholder>.agentdesk.plist`. Plist template lives in the host project as a bundled resource and is copied into place on first run. Manually `launchctl load`-tested across one reboot before flipping to done.
- [ ] R6. Verify on-device launch. Host menu bar icon is visible on the developer's Mac after `just dev`. iOS client placeholder view launches on the developer's personally-owned iPhone via Xcode Run. Capture both confirmations in `HANDOVER.md`: one Mac screenshot of the menu bar icon, one iPhone screenshot of the placeholder view.

### Deferred from Phase 0, fold into Phase 8 (S8, #10) when paid cert lands

- Developer ID-signed `.app` for the host.
- TestFlight internal upload for the iOS client.

Both are blocked on Apple Developer Program enrollment landing. They belong to Phase 8 acceptance, not Phase 0, so they do not carry R-numbers here.

## v0 Phase 1 through 8: captured, not started

Each captured phase expands into a sub-task block (`R7.1`, `R7.2`, ...) when its phase opens. The R-number reserves the slot so cross-references survive renumbering avoidance.

- [x] D7. Phase 1 (S1, #3): QR pairing end-to-end. AFK. Landed in one bundled Codex turn alongside D1, D2, D3, D4. `Pairing` and `PairingClient` modules implement ADR-0002 verbatim, P-256 with Secure Enclave plus Keychain fallback, in-memory nonce map with 90s TTL, FQDN-then-IPv4 host resolution, no token expiry, `agentdesk://pair?p=<base64url>` QR URL. Five Pairing tests and two PairingClient tests pass via Swift Testing.
- R8. Phase 2 (S2, #4): hello-pixels (ScreenCaptureKit + VideoToolbox HEVC + libwebrtc + `AVSampleBufferDisplayLayer`). AFK. Blocked by R7.
- R9. Phase 3 (S3, #5): cursor move and basic click. AFK. Blocked by R8.
- R10. Phase 4 (S4, #6): full trackpad gestures (two-finger right-click, two-finger scroll, double-tap drag). AFK. Blocked by R9.
- R11. Phase 5 (S5, #7): Spaces enumeration via private CGS and 3-finger swipe via synthesized `Ctrl+Arrow`. AFK. Blocked by R10.
- R12. Phase 6 (S6, #8): compact keyboard and accessory row with sticky-tap modifiers. AFK. Blocked by R11.
- R13. Phase 7 (S7, #9): drop-on-background and foreground reconnect under 5 seconds. AFK. Blocked by R12.
- R14. Phase 8 (S8, #10): distribution (notarized DMG, TestFlight) and the 7-day daily-driver self-test. HITL. Blocked by R13 and by Apple Developer Program enrollment landing.

---

## v1 scope (captured, not started until v0 7-day acceptance passes)

v1 unlocks the agent-native UX that `mock-design/` shows and the protocol-already-supports features deferred from v0. R15 onward reserves the number block for v1.

- R15. Per-agent carousel and reasoning ticker. Mirrors the visual target in `mock-design/`. Adds the agent-identity model to the host (one agent equals one Space in v1).
- R16. Multi-display picker on the iOS client. Protocol already carries `displays[]` and `activeDisplayId`; this slice is UI only.
- R17. iPad-optimized layout. Same codebase, anchor sizes adapt.
- R18. Sparkle-based auto-update for the macOS host. Replaces the v0 manual download-and-replace.

### Alternative arc (rejected for v0, captured)

- Code-aware crisp-text overlay. Text rendered separately from the HEVC video track and composited on the client. Useful because HEVC's 4:2:0 chroma subsampling blurs syntax-highlighted edges on small fonts. Rejected for v0 because the 7-day daily-driver test is the empirical decider on whether HEVC's text crispness is good enough as it stands. Revisit if any day during the daily-driver window fails the "can comfortably read code" qualitative check.

---

## Promotion log

```
R0a      2026-05-20  committed   ADR-0001 accepted; ADR-0002 pairing crypto accepted alongside
R1       2026-05-20  committed   macOS host Xcode project skeleton (bundled with R7)
R2       2026-05-20  committed   iOS client Xcode project skeleton (bundled with R7)
R3       2026-05-20  committed   Justfile with configurable iOS test destination
R4       2026-05-20  committed   Xcode automatic free signing on both projects
R5       pending     pending     LaunchAgent plist registered and reboot-tested
R6       pending     pending     on-device launch verified, screenshots in HANDOVER (HITL)
R7       2026-05-20  committed   S1 QR pairing host and client per ADR-0002 (#3)
R8       pending     pending     Phase 2 captured (S2, #4)
R9       pending     pending     Phase 3 captured (S3, #5)
R10      pending     pending     Phase 4 captured (S4, #6)
R11      pending     pending     Phase 5 captured (S5, #7)
R12      pending     pending     Phase 6 captured (S6, #8)
R13      pending     pending     Phase 7 captured (S7, #9)
R14      pending     pending     Phase 8 captured (S8, #10) including deferred S0 items
```
