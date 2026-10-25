---
status: proposed
date: 2026-10-20
---

# Agent Radio speaks audio the Mac makes, pushed to the phone and mixed there

## Context and Problem Statement

Agent Radio (`public/listen.html`, the audio process in `agent-feed/sidecar/src/audio/`) plays one
long AAC stream from the Mac through an `<audio>` element: noise mixed on the Mac with each message
`say` produced. It keeps playing on a locked iPhone, but a message is heard about 8 to 10 seconds
after an agent sends it: `say` takes about 2 seconds, and Chrome's player holds about 8 seconds of a
32 kbit/s stream before it plays. The owner wants agent speech heard within a fraction of a second,
on a locked phone while walking, with the noise steady under the voice and no word ever lost.

Every route below was built and measured on 2026-10-19 and 2026-10-20 on the owner's iPhone (iOS
Safari at the dev origin, over the home Wi-Fi and the tailnet) and this Mac (M2 Pro, busy: load
average about 4 to 5). The test pages, routes and the Mac speech server were throwaway experiments, not committed.

## Decision Drivers

- Delay from an agent's text to sound on the phone, as low as it will go.
- Plays on a locked iPhone, started once by a tap.
- No word is ever dropped: an agent will not notice a missed sentence, and the listener cannot ask
  it to repeat.
- The noise stays level under the voice, with no ducking.
- Memory on the Mac is tight; a resident model must be small.

## Considered Options

- **A. The current stream, tuned.** One paced AAC stream into `<audio src>`.
- **B. The stream fed through Media Source Extensions (MSE).** The page fetches the stream and
  appends it, keeping playback close to the newest audio.
- **C. WebRTC audio.** The Mac sends the mixed channel as a WebRTC track.
- **D. The phone makes the speech.** The Mac sends text; the page speaks it over noise it generates.
- **E. The Mac makes the speech, the phone mixes it.** The Mac pronounces and synthesizes each
  piece of a message and pushes the audio down a stream the page holds open; the page plays it
  into its own Web Audio noise.

## Decision Outcome

Proposed: **Option E**, with Kitten TTS nano 0.8 (fp32 ONNX, CPU) resident on the Mac, espeak-ng in
the same process, a first piece of four words, and the page's own noise in Web Audio with the audio
session set to playback. Measured on the locked phone it is heard 145 to 210 ms after the Mac gets
the text, with no loss and steady noise, for about 240 MB on the Mac.

A is held back by Chrome's player buffer (1.7 s even at 320 kbit/s). B loses nothing but is estimated at
about 0.6 s on the phone, but the phone needs 0.3 to 0.4 s of buffer to ride out Wi-Fi bursts. C is the lowest delay
(about 0.1 s) and does play locked, but drops audio in bursts, and Safari gives a page no way to
lengthen its jitter buffer so resent packets arrive too late; it is the right shape for a future
two-way call, not for messages that must not lose words. D keeps everything on the phone but its
best stable speed was 0.4 to 0.6 s, and the faster GPU path crashes Safari.

### Consequences

- Good, because a message is heard in about 160 ms, roughly 50 times sooner than today.
- Good, because the stream is an ordinary HTTP response: a slow moment delays a piece rather than
  dropping it.
- Good, because the noise is generated on the phone, so it never stops when the network stalls and
  never ducks under the voice; noise level and color become page settings.
- Bad, because the Mac holds a resident model (about 240 MB) and espeak-ng for as long as the
  audio process runs.
- Bad, because the voice is Kitten's: clearer than espeak, less natural than Kokoro, which costs
  0.8 to 1.5 GB on the Mac's GPU for no gain in delay.
- Neutral, because the model's fixed cost per run (about 125 ms) is now most of the delay; a shorter
  first piece does not reduce it.

### Confirmation

The page reports, per message, the Mac's time, the network round trip, the phone's time from
arrival to playback and the audio output latency; the audio process logs them. A message above
300 ms warm, or any lost piece, is a regression.

## Pros and Cons of the Options

### A. The current stream, tuned

Measured in headless Chromium with a loud burst at a known stream position:

| Stream | Sent to heard |
| --- | --- |
| AAC 32 kbit/s | 7.95 s |
| AAC 64 kbit/s | 4.09 s |
| WAV 44 KB/s | 5.24 s |
| AAC 320 kbit/s, 48 kHz stereo | 1.67 s |
| MP3 320 kbit/s | 1.69 s |

- Good, because it already plays locked and loses nothing.
- Bad, because the player decides its own buffer; the format does not change it, the bitrate only
  shrinks it, and the floor is about 1.7 s.

### B. Media Source Extensions

- Good, because the page owns the buffer: Chrome heard a burst 0.25 s after it was sent at 32 kbit/s.
- Good, because Managed Media Source on the iPhone accepted `audio/aac` and played locked.
- Bad, because the iPhone ran dry below 0.3 to 0.4 s of buffer (Wi-Fi delivers in bursts). Chrome
  heard a message 1.0 s after its speech was ready at a 0.5 s target with the splice margin cut to
  four frames; on the phone, 0.3 to 0.4 s of buffer plus that margin puts it near 0.6 s (estimated,
  not measured end to end).
- Bad, because the audio process sent each message in one burst, which a buffer-chasing player
  read as lag and skipped; message frames now go out paced (`audioStream.ts`, uncommitted).

### C. WebRTC audio

- Good, because a message was heard 0.06 to 0.09 s after it was ready, and it kept playing locked
  (contrary to older WebKit reports).
- Bad, because the phone lost 18 to 24 consecutive packets (about 0.4 s) every 6 to 8 s in the first
  minute after connecting, heard as skips in the noise and speech.
- Bad, because with NACK negotiated the Mac resent all 24 packets asked for, but Safari has no
  `jitterBufferTarget`, kept 0.10 to 0.16 s, and concealed the gap anyway.

### D. The phone makes the speech

| Voice in the page | Download | Time to first sound on the phone |
| --- | --- | --- |
| iOS built-in (`speechSynthesis`) | none | plays locked, but iOS ducks the page's noise under it |
| SAM (sam-js) | 21 KB | fast; robotic |
| espeak-ng (WASM) | 18 MB | fast; robotic |
| TinyTTS | 6.5 MB model, 26 MB total | not measured on the phone |
| Kokoro (kokoro-js) | 92 MB | never finished a line in 105 s |
| Kitten nano, one thread | 24 to 57 MB | about 0.8 s |
| Kitten nano, four threads (cross-origin isolated page) | 57 MB | 0.61 to 0.63 s, then about 0.5 s with a short first piece |
| Kitten nano on WebGPU | 24 to 57 MB | 0.15 to 0.2 s, but the tab crashed about 10 s after loading, with or without use |

- Good, because only text crosses the network, and the page's own Web Audio mix kept playing on a
  locked phone.
- Bad, because each model run has a fixed cost the phone's CPU cannot get under about 0.4 s.

### E. The Mac makes the speech, the phone mixes it

Warm, on this Mac, first piece of four words:

| Engine on the Mac | Time | Memory |
| --- | --- | --- |
| Kitten nano fp32, CPU (ONNX Runtime) | 125 to 140 ms | about 240 MB |
| Kokoro-82M, GPU (PyTorch MPS) | 135 ms (2.8 s the first time at a new length) | 0.8 to 1.5 GB |
| Kokoro-82M, CPU (PyTorch) | 250 ms | about 1.0 GB |
| espeak-ng native (pronunciation only) | under 1 ms | |

End to end on the iPhone, Kitten on the Mac, text arriving on the Mac:

| | Mac | Network one way | Phone | Output | Total |
| --- | --- | --- | --- | --- | --- |
| On screen | 125 to 240 ms | 9 ms | 6 to 7 ms | 18 ms | 159 to 274 ms |
| Locked | 112 to 173 ms | 9 to 10 ms | 6 ms | 18 ms | 145 to 210 ms |
| Two-word first piece | 126 to 187 ms | 9 to 10 ms | 6 to 7 ms | 18 ms | 161 to 221 ms |

- Good, because it is the lowest delay that loses nothing, and it plays locked.
- Bad, because the first run at a new input length is slower (about 240 ms); a warm-up across
  lengths would remove it.
- Bad, because the Mac's model time moves with what else the Mac is doing: 112 to 130 ms when it was
  quiet, 290 to 490 ms later the same night under load.
- Neutral, because the Mac makes a whole message as fast as it can; it should stay only a piece or
  two ahead of playback so that a cancelled message stops costing it work.

## Talking back: the mic and interrupting the agent

Measured on the same phone and page on 2026-10-20, ahead of the two-way design. Not yet decided; it
records what the page can do, so the design starts from it.

The mic was opened with `getUserMedia` and echo cancellation (iOS reported echo cancellation on and
noise suppression `undefined`), with the audio session set to `play-and-record`. Levels are the
mic's RMS in dBFS.

| What the mic hears | Level |
| --- | --- |
| The room, with the page's own pink noise playing | -70 to -80 dB: the noise is cancelled |
| The agent's own voice, its first two seconds | -35 to -40 dB: leaks while the canceller adapts |
| The agent's own voice, after that | -66 to -81 dB: cancelled |
| The owner, holding the phone, speaking over the agent | -8 to -28 dB |
| Someone else 1 to 2 m away | not measured; estimated -35 to -45 dB |

- **The mic keeps working on a locked phone.** The track stayed `live`, never `muted`, at the same
  background level, and heard the owner.
- **A locked page's timers are throttled to about one tick in two seconds**, so speech detection
  cannot run on them. It runs in an AudioWorklet that takes the mic and the agent's voice as inputs:
  the audio thread is not throttled while audio plays, and its messages reached the page 3 to 8 ms
  later, locked or not.
- **Detection:** the mic's power smoothed over about 25 ms, above -35 dB (-30 dB while the agent
  speaks, so its leaking start does not count) for 150 ms, where a dip shorter than 100 ms does not
  reset the count. Judged on single 2.7 ms blocks it never fired, because speech dips between
  syllables.
- **Cutting the agent off from the audio thread works**: it was silent about 155 ms after the owner
  began speaking, locked or not, with the rest of the message dropped and the Mac told to cancel.
- **The owner chose to confirm rather than cut off**, so a voice nearby cannot stop the agent:
  speech raises a question for 8 seconds while the agent keeps talking, a banner with a Stop button
  on the page and "Speaking? Press pause to stop" as the lock screen's Now Playing title. A silent
  looping `<audio>` element owns Now Playing, since iOS shows it for a media element and not for
  Web Audio. The lock screen's pause button (or an AirPods press) stops the agent whenever it is
  speaking, question or not, because that press is already deliberate. Measured: the banner tapped
  1.5 s after speaking, pause pressed 3.7 s after; both stopped the agent. A first version tied pause
  to a 4-second question, and a locked owner could not press it in time.
### What the owner says, as text: Apple's dictation in the page

Safari's speech recognition (the Web Speech API, `webkitSpeechRecognition`, which goes through
Apple's Speech framework, the same family as keyboard dictation) was run in the same page as the
noise, the Mac's voice and the mic gate, with the page asking it to listen continuously and starting
it again whenever it ended.

- **It delivers text on a locked phone in real time, but only while the page plays audio.** On a
  page with no audio, phrases said while locked reached the page only on unlock. On the Mac-push
  page, four phrases said locked reached it within seconds, from a hidden page, at confidence 0.70
  to 0.97.
- **It runs beside the mic gate**: both took the mic on a locked phone with no errors.
- **It did not transcribe the agent's own voice** from the speaker in two runs, though that
  message itself says "stop the speech server". Not yet proven beyond those runs.
- **A spoken stop**: a phrase beginning "stop", "wait", "hold on", "pause" or "quiet" stops the
  agent as the pause button does. Acting on the final phrase took 2.3 s from the start of speech,
  because Apple finalizes only after a pause; acting on the provisional words took 0.8 s, with the
  final "Stop" arriving 2.5 s after the agent had already stopped. A stop is never passed on as
  something said.
- **Anything else said goes to the Mac as text** about 2 s after the owner stops speaking: "This
  phone is locked" at confidence 0.99, locked. No speech model runs on the Mac.
- **Not yet known:** whether it needs the network (Apple's servers) or runs on the phone; how it
  does on code words.

Compared on the Mac with the same clips, for the record:

| Engine | Time per clip | Clean synthetic code sentences | The owner's recorded 19.6 s technical passage | Memory |
| --- | --- | --- | --- | --- |
| Whisper large-v3-turbo q4 (MLX) | 0.73 to 0.87 s, whatever the length | Close; "oxlint" heard as "auxilent", "rerun" as "rear on" | Exact | 452 MB in use, 1.27 GB peak with MLX's cache |
| Apple SpeechAnalyzer (macOS 26) | 0.1 to 0.5 s, growing with length | Close; the same misses | Garbled ("cassimeters, urities, it beacles") | Under 20 MB in the calling process; the model's own cost not visible |

### The two-way loop, as it now runs from a locked phone

1. Text on the Mac becomes Kitten speech on the Mac and plays on the phone in 145 to 400 ms (the
   spread is the Mac's load).
2. The owner speaks over it: the mic gate raises a question; a spoken "stop" (about 0.8 s) or the
   pause button stops the agent and cancels the rest of the message.
3. What the owner then says reaches the Mac as text about 2 s after they stop.

Still open for the design: Mac-side transcription stays an option where dictation fails (Whisper is
the accurate one for the owner's voice); a spelling mode and a learned list of misheard identifiers
for code words; and whether dictation needs the network.

## Links

- `agent-feed/wire/audioChannel.ts`, `agent-feed/sidecar/src/audio/`, `packages/AgentPanel/Web/public/listen.html`
- ADR-0083 (Kokoro prewarm in the dormant voice arc), the source of the Kokoro model used here
- Kitten TTS: https://github.com/KittenML/KittenTTS (Apache-2.0); model `KittenML/kitten-tts-nano-0.8-fp32`, revision `7a1db645`
- WebKit background audio fix reported for iOS 17.5: https://github.com/fischnall3r/sadiss/issues/134 (no date verifiable)
