---
status: proposed
date: 2026-05-28
---

# Host-side push-to-talk dictation via in-memory clip transcription

## Context and Problem Statement

The author wants to dictate text on the Mac host: hold a control, speak, release, and get the transcription back. `PRD.md` had listed "no audio" under v0 non-goals, scoped to the iPhone-to-Mac pixels/input pipeline. This decision reopens that line for a host-local utility only. It does not add audio to the WebRTC media plane, the input channel, or the pairing/session contracts. An OpenAI-compatible transcription service runs on the same Mac at `http://localhost:8000/v1/audio/transcriptions` and accepts a multipart upload (`file` plus `model`). The capture must stay entirely in memory, never touching the filesystem.

Affected modules (all host-side, all new except the wiring and config): `host/AgentDeskHost/Config.swift`, `host/AgentDeskHost/WAVEncoder.swift`, `host/AgentDeskHost/MicRecorder.swift`, `host/AgentDeskHost/TranscriptionClient.swift`, `host/AgentDeskHost/DictationBar/`, `host/AgentDeskHost/AppDelegate.swift`, `host/AgentDeskHost/Info.plist`, `host/AgentDeskHost/AgentDeskHost.entitlements`.

## Decision Drivers

- In-memory only. The clip must never be written to disk, so the capture API cannot be one that requires a file URL.
- No new operated service and no change to the iPhone wire contracts. This is a Mac-local convenience, not part of the remote-control thesis.
- The host runs under Hardened Runtime. Microphone access therefore needs the matching resource-access entitlement, not just a usage-description string.
- The transcription endpoint is environment-dependent (port, possibly a different host later). It is config, not a literal.
- Smallest payload that transcribes well. 16 kHz mono 16-bit PCM is the standard speech-recognition input and keeps the multipart body small over loopback.

## Considered Options

- **Option A: AVAudioEngine input tap accumulating PCM in memory, converted to a 16 kHz mono WAV `Data`, POSTed multipart.** No disk. Push-to-talk overlay panel triggers start/stop.
- **Option B: AVAudioRecorder writing to a temp file, then read and POST.** Simplest API, but writes the clip to disk, violating the in-memory constraint.
- **Option C: ScreenCaptureKit audio capture.** The host already runs an SCStream for video; SCK can also emit audio. But SCK audio is system/display audio, not the input device, and is the wrong source for dictation.
- **Option D: send raw PCM with a side-channel sample-rate header instead of a WAV container.** Smaller, but couples the client to the server's framing assumptions; a WAV header is self-describing and universally accepted.

## Decision Outcome

Chose **Option A**.

`AVAudioRecorder` (Option B) is eliminated by the in-memory driver: it only writes to a file URL. ScreenCaptureKit (Option C) captures the wrong source. Raw PCM (Option D) trades a 44-byte header for a brittle out-of-band contract. `AVAudioEngine.inputNode` with an installed tap hands PCM buffers to an `AVAudioConverter` that downsamples to 16 kHz mono Int16; the bytes accumulate in a `Data` buffer guarded by a lock (the tap fires on a realtime audio thread), and `stop()` wraps them with `WAVEncoder` into a finished WAV in memory. `TranscriptionClient` POSTs that `Data` to the OpenAI-compatible endpoint as `multipart/form-data` with fields `file` (the WAV) and `model`.

The trigger is a borderless non-activating `NSPanel` pinned to the bottom-centre of the main screen, joining all Spaces, mirroring the existing `SpaceAgent` overlay pattern. A push-to-talk control records on mouse-down and transcribes on mouse-up, then shows the returned text in the bar.

Two platform requirements are structural, not optional:

- Hardened Runtime requires `com.apple.security.device.audio-input` in an entitlements file (`AgentDeskHost.entitlements`, wired via `CODE_SIGN_ENTITLEMENTS`). Without it the OS denies mic access before the TCC prompt is even useful. This is the host's first entitlements file; it was previously relying on TCC-only permissions (Screen Recording, Accessibility) that need no Hardened Runtime entitlement.
- App Transport Security blocks cleartext HTTP by default. `NSAllowsLocalNetworking` in `Info.plist` exempts loopback (and `.local`) without disabling ATS globally, which is the minimal exception for `http://localhost`.

The endpoint lives in `Config.transcriptionEndpoint`, overridable via `AGENTDESK_TRANSCRIBE_URL`; the model name lives in `Config.transcriptionModel` (`AGENTDESK_TRANSCRIBE_MODEL`, default `whisper-1`).

### Consequences

- Good, because the clip never touches disk: PCM lives in a `Data` buffer and the WAV is assembled in memory before upload.
- Good, because it adds zero surface to the iPhone wire contracts (pairing, session, media, input). A failure here cannot affect remote control.
- Good, because `WAVEncoder` is a pure Foundation function, unit-testable without a live audio engine.
- Bad, because it reopens the PRD "no audio" non-goal. Mitigated by scoping strictly to a host-local utility and recording the reopening here and in `PRD.md`.
- Bad, because it introduces the host's first outbound HTTP path and first entitlements file, two new surfaces to maintain. Both are minimal and isolated.
- Neutral, because the transcription server is assumed to return `{ "text": "..." }`. A different response shape is a one-line decode change in `TranscriptionClient`.

### Confirmation

- `WAVEncoderTests` asserts the 44-byte header layout (RIFF/WAVE/fmt /data tags, sample rate, byte rate, block align, bits per sample, data size) for 16 kHz mono and that PCM samples are appended verbatim.
- Live integration: with the transcription server on `:8000`, hold the bar's mic, speak, release; the transcript appears in the bar. Logged under subsystem `com.example.agentdesk.AgentDeskHost`, category `dictation` / `mic`.
- The capture path uses `AVAudioEngine`, never `AVAudioRecorder`; a code-review check that no file URL appears in the capture path keeps the in-memory constraint enforced.

## Pros and Cons of the Options

### Option A (chosen)

- Good, because in-memory by construction and self-describing WAV payload.
- Good, because reuses the established `NSPanel` overlay pattern for the trigger UI.
- Bad, because the realtime tap thread forces a lock around the accumulator.

### Option B

- Good, because `AVAudioRecorder` is the least code.
- Bad, because it writes the clip to disk, which the requirement forbids.

### Option C

- Bad, because ScreenCaptureKit audio is system/display audio, not the microphone input device.

### Option D

- Good, because a few dozen bytes smaller per clip.
- Bad, because it couples client and server to an out-of-band sample-rate contract instead of a standard container.

## Links

- SPEC §Stack, §Module boundaries (Host)
- PRD "What v0 is not" (audio non-goal, reopened for host-local dictation)
- ADR-0001 v0 stack and transport (Hardened Runtime, permission model)
- Apple Developer: Hardened Runtime resource-access entitlement `com.apple.security.device.audio-input` (no date verifiable)
- Apple Developer: `NSAllowsLocalNetworking` ATS exception for loopback (no date verifiable)
