---
status: partially superseded by ADR-0084
date: 2026-07-29
partially-superseded-by: ADR-0084 (store-wide lock only; background prewarm and retained model ownership stand)
---

# Prewarm host Kokoro when the voice sidecar starts

## Context and Problem Statement

The first reference-speech request after a host restart paid Kokoro package import, model loading,
default-voice loading, and first inference on the request path. The measured package import alone
took approximately 29 seconds when cold. Once loaded, the same retained synthesizer served later
uncached artifacts in under one second.

The complete isolated Kokoro process occupied approximately 899 MB after synthesis. Paying that
residency cost at sidecar start removes the first-request delay, but it must not block HTTP liveness,
persist a fake reference artifact, or race an immediate real request into a second model load.

## Decision Drivers

- The first reference-speech request after host launch should use the retained warm synthesizer.
- Voice-server liveness must not wait for Kokoro import, asset verification, or inference.
- Prewarm and real synthesis must share one serialization boundary and one model owner.
- Prewarm must exercise inference without adding an entry to the durable artifact cache.
- Failure must remain visible while allowing the first real request to retry.

## Considered Options

- **Option A**: Keep Kokoro lazy on the first reference-speech request.
- **Option B**: Block FastAPI startup until Kokoro is warm.
- **Option C**: Schedule retained-store prewarm concurrently with Whisper prewarm.

## Decision Outcome

Chose **Option C**. FastAPI lifespan starts a background Kokoro task beside the existing Whisper
task. The task calls the same `ReferenceSpeechArtifactStore` retained by the REST endpoints. Its
existing lock serializes startup prewarm with real artifact creation, so whichever enters first
becomes the only model-loading owner.

Prewarm synthesizes one short direct-IPA phrase with the default voice and default speed under
PyTorch inference mode, then discards the audio. It creates no artifact or cache metadata. An
explicit inference-warm flag makes later prewarm calls no-ops only after successful inference, not
merely after asset loading. `kokoroPrewarm` records whether cold work occurred, success or failure,
the error type, and total time. Failure is logged and leaves real synthesis able to retry.

The Kokoro model and default voice remain resident for the voice-sidecar lifetime. R174 captures a
later measured idle-eviction or on-demand reload policy if the accepted footprint harms ordinary
host use.

### Consequences

- Good, because host startup begins paying the Kokoro cold cost before reference playback.
- Good, because HTTP health remains available while both voice models warm concurrently.
- Good, because one retained store and lock prevent duplicate Kokoro model construction.
- Good, because the prewarm produces no durable reference-speech artifact.
- Bad, because Kokoro occupies memory even when reference playback is unused.
- Neutral, because an immediate request may wait for unfinished prewarm but cannot race it.

### Confirmation

Python tests assert that prewarm exercises the default direct-IPA voice once, becomes idempotent
only after inference, uses the retained store without writing an artifact, starts during FastAPI
lifespan beside Whisper prewarm, and leaves `/health` responsive.

## Links

- ADR-0076 Let the Mac host own shared voice recordings and analysis
- ADR-0082 Prewarm host Whisper when the voice sidecar starts
