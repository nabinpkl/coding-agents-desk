# TASKS: v15 pronunciation gap finder

`R<N>` = remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This ledger starts after R127, the highest task ID in the retained task ledgers. Archived checkpoints
remain incomplete unless their own ledgers record otherwise.

## Position

The landed iOS 26 Voice surface is a speech-recognition context probe, not a pronunciation analyzer.
It captures one microphone take as PCM, converts it to the format requested by `SpeechAnalyzer`, and
transcribes the same buffers twice: once normally and once with the target phrase supplied as
recognition vocabulary bias. The synthesized reference is playback only.

The first physical result produced `think` in both passes with `thank` as an unaided alternative. That
proves microphone capture, conversion, on-device transcription, and alternative reporting work. It
does not show that target-context bias adds useful information, and it says nothing about which phone
was produced, pronunciation quality, reference similarity, speaker identity, or improvement over
time.

Evidence persistence comes first because every later model and scoring decision needs replayable
takes rather than recollection from a transient screen. Phoneme evidence precedes GOP because a score
without inspectable phone posteriors and timing cannot explain a gap. Reference comparison follows
only after its speaker-identity confound has an explicit evaluation gate. History is last because its
schema must store stable, interpretable signals rather than freeze an exploratory verdict.

These are candidate vertical slices, not accepted model or product decisions. Each slice must retain
the raw evidence, state what it measures, and reject itself when its acceptance signal fails.

## Current signal inventory

| Signal | Current source | What it can show | What it cannot show | Failure shape |
|---|---|---|---|---|
| Unaided transcription | Apple `SpeechTranscriber` | The recognizer's top text, alternatives, and confidence | Which sound caused a word choice or whether pronunciation was correct | Accent-robust ASR can recover the intended word while hiding useful pronunciation differences |
| Target-biased transcription | `AnalysisContext.contextualStrings` | Whether vocabulary bias changes recognition of the same audio | Natural conversational context, phoneme correctness, or human intelligibility | The hint may merely force the expected word or may add no observable information |
| Synthesized reference | `AVSpeechSynthesizer` playback | A phrase the learner can hear | Any comparison with the learner's recording | Playback can be mistaken for an analyzed reference even though no samples are retained |

## v15 Phase 0: retain evidence and decide the context probe

- D128. Land the iOS 26 speech-context playground with safe off-main microphone callbacks, complete
  capture teardown, one buffered take replayed through unaided and target-biased transcription,
  alternatives, confidence, TTS playback, focused tests, and physical verification through Stop and
  both analyzer passes.
- R129. Persist each take in app-owned storage with lossless audio, target phrase, locale, duration,
  timestamp, build identity, analyzer format, both top transcripts, ordered alternatives,
  confidences, and context verdict; add explicit retention and deletion controls, replay the same take
  without using the microphone, rename `Heard instead` to `Other recognition candidates`, distinguish
  top-result from alternative-only matches, and run a saved minimal-pair matrix that decides whether
  the target-biased pass remains a product signal or is removed while ordinary STT stays.
  - Implementation landed: every retained take is a versioned `audio.caf` plus `metadata.json`,
    inline view-analysis/replay/delete and retain/discard controls are present, recognition
    candidates retain order and confidence, match rank is explicit, and the matrix applies a tested
    keep/remove rule across `think/sink`, `rice/lice`, `very/wary`, and `ship/sheep`. Voice is an
    always-present local toggle
    beside Settings: it replaces pairing or session UI immediately, works on first launch, and does
    not initiate a host session or media path until the user returns to a host-backed surface. A
    rolling amplitude waveform shows microphone power below the recorder while recording and
    saved-audio power inline within the active saved-take card during replay.
  - Remaining acceptance: on the physical iPhone, collect two completed retained takes for each of
    the eight prompts, verify replay and deletion against the matching build identity, and accept the
    resulting keep/remove recommendation. R129 stays open until this observed evidence exists.

## v15 Phase 1: phoneme-level gap evidence

- R130. Spike and select an on-device phoneme model and target grapheme-to-phoneme source, then produce
  inspectable phone hypotheses, time ranges, and competing phones for saved takes; prove on a bounded
  labeled set that contrasts such as `/θ/` to `/t/` or `/s/` are localized without relying on the STT
  transcript, and reject checkpoints that normalize those differences away.

## v15 Phase 2: calibrated pronunciation score

- R131. Derive a GOP or equivalent per-phone margin from R130's posterior evidence, preserve the
  underlying target and competing-phone values beside every score, and calibrate any learner-facing
  scale against labeled non-native speech before displaying it; do not ship an arbitrary distance
  transformed into a percentage.

## v15 Phase 3: analyzable reference audio

- R132. Replace playback-only reference handling with a first-class reference source that can retain
  synthesized audio or an explicitly chosen real recording in the same analysis format as learner
  takes; show provenance in the UI and keep listening independent from scoring so playing the
  reference can never contaminate a live recording.

## v15 Phase 4: speaker-reduced reference comparison

- R133. Evaluate acoustic embeddings, normalization, and layer selection on saved reference/learner
  pairs before adopting DTW; require the representation to separate deliberate pronunciation changes
  more strongly than different correct speakers, then add time-aligned embedding comparison and
  surface divergent regions without presenting distance-to-one-speaker as pronunciation correctness.

## v15 Phase 5: baselines and improvement history

- R134. Build phrase-keyed attempt history over the stable signals from R129-R133: replayable learner
  audio, reference provenance, unaided STT, alternatives, phone evidence, calibrated pronunciation
  scores, and aligned reference deviations; let the learner choose a baseline, compare attempts, and
  delete recordings and derived results together.

## v15 Phase 6: integrated coaching loop

- R135. Combine the retained signals into one explainable result that separately answers what words
  were recognized, which phones were confusable, how the take differed from the selected reference,
  and whether the learner improved; validate the loop with saved correct and deliberately altered
  takes before any claim that the app measures pronunciation quality.
- R136. Run focused client tests and `just check`, self-review the integrated task diff, then stop at
  the device checkpoint; after explicit approval, reinstall the current client and verify recording,
  replay, deletion, phoneme evidence, reference comparison, and history on the physical iPhone with
  matching build identity.

## Promotion log

```text
D128  2026-07-25  landed     safe raw-audio capture and dual Apple recognition-context probe
R129  implemented remaining  physical 16-take context-signal decision
R130  candidate   remaining  phoneme-level hypotheses and timing
R131  candidate   remaining  calibrated GOP or equivalent phone score
R132  candidate   remaining  retained synthesized or real reference audio
R133  candidate   remaining  speaker-reduced embeddings and DTW comparison
R134  candidate   remaining  baselines and longitudinal attempt history
R135  candidate   remaining  integrated explainable pronunciation gap loop
R136  checkpoint  remaining  authorized physical-device acceptance
```
