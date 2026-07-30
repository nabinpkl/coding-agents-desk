---
status: accepted
date: 2026-07-30
---

# Make practice passages the shared Voice library authority

## Context and Problem Statement

The host-owned Voice library stored one transcript per recording and reused it as both Whisper's
observation and the pronunciation target. A recognition error therefore changed the reference phones
and synthesized reference speech, while overwriting the transcript would destroy evidence needed to
understand the recognizer. Retakes also appeared as unrelated cards instead of attempts at one
exercise.

## Decision Drivers

- The user must own the intended text without mutating Whisper's original observation.
- Retakes must preserve independent WAV, transcript, phone, provenance, and transport evidence.
- Mac and iPhone must read and mutate one host-authoritative library.
- Reference phones and speech must follow current intended text and reject stale word indexes.
- Attempt history and destructive operations must remain bounded, revision-fenced, and recoverable.

## Considered Options

- **Option A**: Let the user overwrite each recording transcript.
- **Option B**: Add editable reference text independently to every recording card.
- **Option C**: Make a practice passage own intended text and group immutable attempts by opaque ID.

## Decision Outcome

Chose **Option C**. A practice passage owns an opaque ID, normalized intended text, revision,
timestamps, and optional baseline recording ID. Every attempt keeps its existing recording ID and
adds a passage ID. Whisper's machine transcript remains immutable after finalization. Reference
phones, heard-phone display grouping, and Kokoro speech resolve the current passage text. Recording a
retake carries the passage ID and revision captured at start; a new free-form take creates a passage
whose intended text is seeded from the machine transcript for explicit review.

Legacy recording metadata upgrades once to schema 4. Each legacy recording receives a deterministic
one-attempt passage, and both intended text and machine transcript begin from the old transcript.
There is no dual legacy read contract after migration.

Passage and attempt listings use bounded cursor pages. Intended-text and baseline mutations require
the expected revision. Reference-speech requests carry passage ID plus revision. The host blocks
intended-text edits and whole-passage deletion while that passage has an active retake. Attempt
deletion keeps an explicit empty passage; whole-passage deletion removes every owned attempt but does
not claim to purge the global content-addressed Kokoro cache.

### Consequences

- Good, because correcting `would` to `are` changes reference evidence without changing the WAV or
  machine transcript.
- Good, because retakes form one navigable history with explicit baseline and A/B playback.
- Good, because stale Mac or iPhone mutations fail with a conflict instead of overwriting newer text.
- Bad, because passage summaries derive attempt count and activity by scanning recording metadata;
  a future large library may require an indexed store.
- Neutral, because the separate native on-device Passage experiment remains independent.

### Confirmation

Python tests cover deterministic migration, immutable attempt evidence after text edits, revision
conflicts, reference-artifact identity, pagination, baseline behavior, retake attachment,
empty-passage retention, deletion, and failure rollback. Web tests cover word-diff semantics plus
loading, empty, error, edit, conflict, retake, cross-page A/B, unknown-word, and accessibility
states. Host tests enforce the exact native REST allowlist. The physical acceptance script in TASKS
R183 verifies Mac and iPhone against the same host library.

## Pros and Cons of the Options

### Option A

- Good, because it adds one small edit control.
- Bad, because it destroys the recognizer observation and makes diagnostics irreproducible.

### Option B

- Good, because it preserves the machine transcript.
- Bad, because retakes duplicate intended text and remain unrelated records that can drift.

### Option C

- Good, because intended text has one authoritative home and every attempt remains evidence.
- Bad, because it introduces a passage lifecycle, revisions, migration, and bounded history APIs.

## Links

- SPEC §Host-owned shared voice flow
- ADR-0076 Let the Mac host own shared voice recordings and analysis
- ADR-0084 Separate reference cache access from Kokoro model serialization
