---
status: accepted
date: 2026-07-29
supersedes: ADR-0083 (store-wide lock only; background prewarm and retained model ownership stand)
---

# Separate reference cache access from Kokoro model serialization

## Context and Problem Statement

ADR-0083 put startup prewarm and reference-speech requests under one store lock. This prevented
duplicate model construction, but it also made a cached WAV wait for unrelated model work. A live
cached request took 5.425 seconds when it overlapped a 5.592-second warm-process prewarm. The
initial cold prewarm previously took 53.745 seconds, so the same locking shape could hold an
already-generated WAV for nearly the full cold-start interval.

The generated cache was also bounded at 2 GiB even though the measured live cache was 2.9 MB for 28
artifact pairs. Maintenance ran only after writes, left orphan and temporary files in place, and
could return success after immediately evicting an artifact larger than the configured limit.
`FileResponse` resolved a path before opening it, so concurrent eviction could remove the WAV
between lookup and response delivery.

## Decision Drivers

- Cached playback must not depend on Kokoro import, model loading, prewarm, or inference.
- Prewarm and cache misses must still share one model owner and prevent duplicate synthesis.
- Startup and post-write maintenance must enforce one small, configurable disk bound.
- Partial, orphan, corrupt, and oversized artifacts must fail or be removed explicitly.
- A WAV being sent to a client must remain present for the response lifetime.

## Considered Options

- **Option A**: Keep one store-wide lock and accept cached-playback stalls during prewarm.
- **Option B**: Use independent cache and synthesis locks while preserving one retained
  synthesizer.
- **Option C**: Run multiple Kokoro owners so prewarm and real synthesis never wait on each other.

## Decision Outcome

Chose **Option B**. The artifact store owns a short cache lock for validation, metadata access,
atomic persistence, pruning, and leases. A separate synthesis lock owns Kokoro prewarm and real
inference. A cache miss acquires the synthesis lock and then rechecks the cache before inference,
so concurrent identical misses still coalesce and only one model owner loads or synthesizes.
Prewarm completes startup cache maintenance before entering model work, then releases the cache
lock for the full import and inference interval.

The default generated-artifact bound is 256 MiB and remains configurable through
`VOICE_REFERENCE_SPEECH_CACHE_BYTES`. Startup prewarm and every write remove unmanaged files and
incomplete pairs, then evict complete pairs by metadata access time. An artifact larger than the
whole bound is deleted and the create request fails visibly. A newly created artifact is protected
during its write transaction. Audio responses lease their artifact until `FileResponse` finishes;
leased pairs may temporarily put the directory above the bound and are reconsidered immediately
when the final lease releases.

This supersedes ADR-0083 only where it selected one store-wide lock. ADR-0083's background prewarm,
retained synthesizer, discarded warmup audio, timing, and process-lifetime residency decisions
remain in force.

### Consequences

- Good, because cache hits remain low-latency during both warm and cold Kokoro prewarm.
- Good, because prewarm and cache misses still cannot construct or use the model concurrently.
- Good, because the smaller cache is maintained at startup as well as after writes.
- Good, because active downloads cannot lose their file to concurrent eviction.
- Bad, because the cache can temporarily exceed 256 MiB while an older artifact is being served.
- Neutral, because uncached synthesis still waits for prewarm by design.

### Confirmation

Python tests overlap a blocked prewarm with a cache hit, assert one synthesis for concurrent
identical misses, exercise startup pruning, LRU eviction, orphan cleanup, strict oversized-artifact
failure, and hold an audio lease across eviction before verifying cleanup on release. HTTP tests
exercise response delivery through the leased path.

## Links

- ADR-0083 Prewarm host Kokoro when the voice sidecar starts
- ADR-0076 Let the Mac host own shared voice recordings and analysis
