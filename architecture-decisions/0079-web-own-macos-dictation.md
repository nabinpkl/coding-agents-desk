---
status: accepted
date: 2026-07-27
supersedes: ADR-0010
---

# Let the shared web voice session own macOS dictation audio

## Context and Problem Statement

The all-Spaces Mac dictation bar had a separate Swift `AVAudioEngine` recorder,
WAV encoder, and transcription client. That path bypassed the host-owned
recording library used by the Gesture/Voice InteractionPanel, so dictation did
not create reviewable recordings or receive the same ZIPA analysis.

## Decision

The all-Spaces bar is now a small `dictation.html` InteractionPanel webview.
It uses the existing browser microphone capture, `VoiceSocket`, and loopback
Python sidecar with `source=macos`. Swift retains only panel geometry, global
Fn/Globe press-to-talk forwarding, bundled-origin microphone permission,
focused-app text insertion, and recording-ID deduplication.

The mini commits text only from the authoritative `sessionComplete.recording`.
It does not insert partial speech, run a Swift fallback recorder, or send PCM
through the native bridge. A retained full InteractionPanel opens directly to
Voice through native delivery only after a mini run is terminal.

## Consequences

- Good, because Mac dictation and the full Mac/iPhone Voice panels share one
  durable recording, transcription, phone-analysis, and interruption path.
- Good, because microphone permission stays constrained to the bundled
  `interactionfeed://app` origin and microphone capture type.
- Bad, because a first Fn-triggered capture can be rejected by WebKit before a
  user click has established microphone permission; the mini tells the user to
  click the mic and deliberately has no native fallback.

## Confirmation

The generated InteractionPanel bundle must contain `index.html` and
`dictation.html`. Contract tests decode every mini bridge request, the host
build/test gate compiles the all-Spaces shell, and `just check-all` remains the
automated gate. Runtime acceptance covers click and Fn capture, host recording
visibility, text insertion, busy rejection, and interrupted persistence.

## Links

- ADR-0010
- ADR-0076
- SPEC.md Host-owned shared voice flow
