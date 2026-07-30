---
status: accepted
date: 2026-07-29
---

# Prewarm host Whisper when the voice sidecar starts

## Context and Problem Statement

The first MLX transcription after a host restart paid model import, model loading, and first
inference on the user's first dictation. One measured restart spent 27.068 seconds importing
`mlx_whisper`; after the model became resident, later transcription imports were below 0.1
milliseconds and inference stayed below one second. Keeping first-use latency on the capture path
made host restart timing user-visible even though the voice sidecar starts with the host.

The same warmed run reported approximately 473 MB active MLX memory, 915 MB of MLX cache, and a
1.33 GB peak. These counters overlap in unified memory and are not additive, but they make the
process-lifetime residency cost large enough to track explicitly.

## Decision Drivers

- The first dictation after host launch should use the same resident MLX model as later dictations.
- Voice-server liveness must not wait for model download or a cold import.
- Prewarm and real inference must not race or create two model owners.
- The accepted memory cost and the trigger for revisiting it must remain explicit.

## Considered Options

- **Option A**: Keep lazy model loading on the first real transcription.
- **Option B**: Block FastAPI startup until the model is warm.
- **Option C**: Schedule a silent prewarm inference through the existing MLX executor.

## Decision Outcome

Chose **Option C**. FastAPI lifespan schedules one in-memory silent inference for the configured
final transcription model. It runs through the same process-wide single-worker executor as live,
final, and REST transcription, so a dictation started immediately queues behind prewarm instead of
racing it. HTTP liveness remains available while model files are prepared. Prewarm emits one
`mlxPrewarm` timing event containing import, model resolution, inference, residency, and MLX memory
measurements. A failed prewarm is visible and leaves the first real transcription able to retry.

The loaded model remains resident for the voice sidecar process lifetime. This intentionally accepts
the measured MLX memory footprint to remove restart-cold latency from the first dictation. R172
captures a later measured idle-eviction or on-demand reload policy if host memory pressure shows that
process-lifetime residency is too expensive.

### Consequences

- Good, because normal host startup begins paying the cold MLX cost before the first dictation.
- Good, because one executor and `ModelHolder` remain the only inference and residency authority.
- Good, because server liveness and model preparation are independent.
- Bad, because the Whisper model occupies unified memory even when voice is unused.
- Neutral, because an immediate dictation can still wait behind an unfinished prewarm, but no longer
  starts a second cold path.

### Confirmation

Python tests assert prewarm uses silent in-memory audio, makes the first real transcription warm,
skips duplicate inference once resident, keeps failures cold for retry, starts during FastAPI
lifespan, and leaves `/health` responsive. Runtime acceptance checks that `mlxPrewarm` reports
`modelResidentAfterCall=true` before the first real `mlxTranscription`, whose
`modelResidentBeforeCall` must then be true.

## Links

- ADR-0076 Let the Mac host own shared voice recordings and analysis
- ADR-0079 Let the shared web voice session own macOS dictation audio
- SPEC §Host-owned shared voice flow
