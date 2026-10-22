---
status: accepted
date: 2026-10-22
---

# The speech process speaks with Phonon, streamed from the Mac's GPU

## Context and Problem Statement

The speech process (`agent-feed/speech/speech_server.py`) turns an agent's text into speech on this
Mac and pushes it to the phone's page, which plays it: a Bot session finishing its turn, and a reply
read out loud from the feed's speaker. It spoke with Kitten TTS nano 0.8, which reads text through
espeak-ng's pronunciation rules, so a word espeak-ng does not know is guessed from its spelling. In
this repository's speech that is most of the words that matter: "tmux", "ADR", "oxlint", a camelCase
name. Kitten also made each piece whole before any of it played, which held the first sound to about
120 ms on the CPU and made every piece a burst of memory.

## Decision Drivers

- A technical word is said the way it is said, not spelled out by rule: the owner's test is a line
  with "tmux" and "ADR" in it.
- Speech starts as soon as possible after the text arrives.
- About 300 MB of memory on the Mac, flat however long the text, with no PyTorch (whose import alone
  is about 140 MB, measured 2026-10-21).
- Voices to pick from, switched without restarting anything.

## Considered Options

Each was measured on this Mac (M2 Pro) on 2026-10-21, saying the same lines; the samples are on the
push page's "Voice samples" page.

- **Kitten nano, kept**: espeak-ng pronunciation; 120 ms for a 4-word piece on the CPU, about 360 MB
  (on MLX's GPU 51 to 60 ms and about 170 MB, but the same pronunciation).
- **Kokoro-82M**: espeak-ng or misaki pronunciation; on MLX's GPU in half precision 136 to 159 ms, about
  280 MB with peaks of 750 to 870 MB per piece, 433 MB with misaki. Last released January 2025.
- **Soprano 1.1 (80M)**, own tokenizer: MLX's port makes each piece whole, 138 ms, 430 to 480 MB.
- **MOSS-TTS-Nano (100M)**, own tokenizer: 753 ms for a 4-word piece, peaks up to 1.3 GB, and speaks
  only in a voice cloned from a recording.
- **Pocket TTS (Kyutai, 100M)**, own tokenizer, streamed: 30 ms to the first audio on MLX's GPU at
  8-bit, about 300 MB, CC-BY-4.0.
- **Phonon 31M English (Gradium)**, own tokenizer, streamed: 7 to 12 ms to the first audio on the GPU
  through its `ptts` runtime, about 235 MB, Apache-2.0, 25 everyday English voices in its catalog.

## Decision Outcome

Chose **Phonon 31M on the GPU, streamed**, with no other voice behind it. It meets every driver and
is the fastest and lightest of the two that do: it reads text through its own tokenizer, makes
speech one 80 ms frame at a time so memory stays flat and the first frame is out in tens of
milliseconds, and its catalog gives a choice of voices. Kitten and Kokoro fail the first driver;
Soprano and MOSS-TTS-Nano fail the memory driver and do not stream; Pocket TTS meets them all but is
slower to start, heavier, and needs a voice set up for every message.

The speech process loads it once (`ptts.TTS(..., device="metal")`), streams each message's frames to
the page as they are made, paced to three seconds ahead of playback, and lists and switches voices
(`GET /voices`, `POST /voice`). The page stretches speech to its speed slider (pitch kept); the Mac
is told the speed only to pace what it sends. The model and voices are fetched once per machine,
pinned to commits, by `just speech-voice` (`agent-feed/speech/fetch_voice.py`), so speaking never
reaches the network.

### Consequences

- Good, because the first sound is heard about a tenth of a second sooner, and words like "tmux" and
  "ADR" come out as said rather than as guessed.
- Good, because memory is about 235 MB and flat: no piece-sized bursts, no PyTorch, and the environment
  holds two packages (`ptts`, `numpy`).
- Bad, because the model and `ptts` 0.4.0 were released on 2026-10-20, two days before this, with
  150 stars on the runtime's repository: young, and a dependency to watch.
- Bad, because it runs on the GPU only, by choice: the CPU took 15 s for a paragraph the GPU made in
  0.9 s. A Mac without Metal would not speak.
- Neutral, because the voice is English only; the catalog's other languages need Gradium's 40M
  multilingual model, which is gated and non-commercial.
- Neutral, because a voice picked on the phone is held by the speech process until it restarts; the
  page sends its choice again on every connection, as it does its speed.

### Confirmation

The speech process logs `ready ... Phonon on Metal` when it starts, and each message's first frame
with its delay and voice (`[speech] #n: first audio out after N ms, in <voice>`).

## Links

- `agent-feed/speech/speech_server.py`, `agent-feed/speech/fetch_voice.py`
- `packages/AgentPanel/Web/public/experiments/local-test.html?push=1`, the page that plays it
- https://huggingface.co/gradium/phonon-31m-en, https://github.com/gradium-ai/xn-ptts (2026-10-22)
