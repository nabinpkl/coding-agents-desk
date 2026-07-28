---
status: accepted
date: 2026-07-28
---

# Let the containing app own keyboard dictation capture

## Context and Problem Statement

iOS keyboard extensions cannot capture microphone audio, but AgentDesk needs a complete systemwide
keyboard whose dictation uses the same host-owned recording, Whisper, and ZIPA pipeline as Voice.
The extension must remain useful without Full Access or a connected Mac, while an explicitly armed
containing app may keep a narrowly scoped background audio session alive.

## Decision Drivers

- Ordinary typed text must remain local to `UITextDocumentProxy`.
- Only explicit dictation audio may enter the authenticated role-7 voice lane.
- A stopped or interrupted take must correlate to one durable host recording.
- The keyboard must stay responsive within extension launch and memory constraints.
- Background authority must be explicit, visible, bounded, and fully revocable.

## Considered Options

- **Native keyboard plus app-owned background capture**: App Group commands control one armed app
  service; Python remains authoritative.
- **WebView in the extension**: reuse the InteractionPanel UI and voice store.
- **Extension-owned capture or on-device fallback**: record or transcribe inside the keyboard.

## Decision Outcome

Chose **native keyboard plus app-owned background capture**. UIKit keeps launch and memory cost
bounded and supplies a complete keyboard even without Full Access. The containing app is the only
process with microphone authority; it discards idle buffers locally and sends explicit takes through
the existing voice lane. WebKit cannot solve extension microphone ownership, and an on-device
fallback would create a second transcription and recording authority.

### Consequences

- Good, because typed characters never cross the App Group or network boundary.
- Good, because Mac and iPhone voice takes share one host recording and analysis pipeline.
- Good, because `clientSessionID` supports exact interrupted-take reconciliation.
- Bad, because the user must explicitly activate AgentDesk and keep a visible microphone indicator.
- Bad, because Apple guideline 4.4.1 says keyboard extensions may not launch apps other than
  Settings. The Link handoff is internal-TestFlight-only unless Apple grants an exception or the
  product is redesigned.
- Neutral, because the existing video-path keyboard and manual dictation sheet remain separate.

### Confirmation

Package tests cover state round trips, generations, preferences, expiry, layouts, and insertion
guards. Client tests cover ordered bounded audio delivery, while generic builds compile the native
keyboard and containing-app service together. Host/Python tests cover session correlation and
interrupted persistence. Physical acceptance verifies QWERTY fallback, swipe-back continuity, safe
insertion, other-audio mixing, failures, and Turn Off cleanup.

## Links

- SPEC §Systemwide keyboard dictation
- ADR-0076 Let the Mac host own shared voice recordings and analysis
- Apple App Review Guidelines, no publication date verifiable:
  https://developer.apple.com/app-store/review/guidelines/
- Wispr Flow iOS 26.4 guidance, updated July 2026:
  https://docs.wisprflow.ai/articles/6269634092-adapting-to-ios-26-4
