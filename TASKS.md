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
    tall rolling amplitude waveform shows microphone power below the recorder while recording and
    saved-audio power inline within the active saved-take card during replay; its presentation-only
    dB curve suppresses room tone and gives ordinary speech substantially more visual height.
  - Remaining acceptance: on the physical iPhone, collect two completed retained takes for each of
    the eight prompts, verify replay and deletion against the matching build identity, and accept the
    resulting keep/remove recommendation. R129 stays open until this observed evidence exists.

## v15 Phase 1: phoneme-level gap evidence

- R130. Spike and select an on-device phoneme model and target grapheme-to-phoneme source, then produce
  inspectable phone hypotheses, time ranges, and competing phones for saved takes; prove on a bounded
  labeled set that contrasts such as `/θ/` to `/t/` or `/s/` are localized without relying on the STT
  transcript, and reject checkpoints that normalize those differences away.

### July 2026 decision baseline

- Apple `SpeechTranscriber` remains the word-recognition path, not the phone analyzer. Its public
  iOS 26+ surface provides transcriptions, alternatives, confidence, and audio time ranges, but no
  documented phone posterior or phone-lattice output. R130 may display STT beside phone evidence for
  comparison, but the phone analyzer must not read `VoiceAttemptAnalysis`, either transcript, or any
  recognition alternative.
- Prefer Core ML for the selected shipping runtime because it is the platform-owned on-device
  inference path and supports flexible tensor shapes and compressed ML Program weights. The first
  acoustic reference is Meta's Apache-2.0 `wav2vec2-lv-60-espeak-cv-ft`: the reproducible Sadda fp16
  ONNX export accepts normalized mono 16 kHz PCM and emits 392 unconstrained CTC phone logits at
  50 frames per second. It is a fidelity reference, not a shipping asset: the file is about 635 MB
  and has no adoption history.
- Compare the fp16 reference against the ONNX Community Q4F16 export, about 197 MB, and a Core ML
  conversion with 8-bit and 4-bit weight compression. A compressed candidate is rejected if it
  changes the key-phone winner or erases a contrast, even if its aggregate transcription still looks
  correct. The 94M-parameter LJSpeech/Gruut wav2vec2 checkpoint is only a compact fallback candidate;
  its single-speaker training and 2024 maintenance state make it unsuitable without stronger evidence.
- Use a pinned CMUdict revision as the bounded US-English target-pronunciation source, plus an explicit
  stressed-ARPABET to model-token mapping. Every emitted token must exist in the selected model
  vocabulary, alternate dictionary pronunciations stay explicit, and an unknown word fails visibly.
  Do not link eSpeak NG into the app: its phone inventory matches the acoustic model, but the engine is
  GPL-3.0-or-later. Flite is not the fallback because its last release and iOS posture are stale.
- Current sources checked on 2026-07-25: [Apple SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber?changes=_1),
  [Apple Core ML](https://developer.apple.com/documentation/CoreML),
  [Core ML flexible inputs](https://apple.github.io/coremltools/docs-guides/source/flexible-inputs.html),
  [Core ML compression](https://apple.github.io/coremltools/docs-guides/source/opt-whats-new.html),
  [Sadda fp16 model card](https://huggingface.co/sadda-speech/wav2vec2-espeak-ctc),
  [ONNX Community model card](https://huggingface.co/onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX),
  [CMUdict](https://github.com/cmusphinx/cmudict), and
  [eSpeak NG licensing](https://github.com/espeak-ng/espeak-ng#license-information). The Apple and
  Core ML guide pages expose no publication date; their current documentation was inspected rather
  than treating older API examples as authority.

### R130 execution plan

1. **Freeze an evidence contract before integrating a runtime.**
   - Add a small `VoicePhoneAnalyzer` boundary whose request contains only the saved audio URL,
     target pronunciation, locale, and pinned model manifest.
   - Return a versioned `VoicePhoneEvidence`: attempt ID, audio SHA-256, model/revision/conversion and
     vocabulary hashes, 20 ms top-five phone hypotheses with log posteriors, target-aligned phone
     ranges, target posterior, strongest competing phone, posterior margin, and inference metrics.
   - Keep PCM normalization, model invocation, CTC blank handling, forced alignment, and phone-token
     mapping behind this boundary. Do not derive or display a pronunciation percentage in Phase 1.

2. **Build the bounded evidence set from the recording seam that already exists.**
   - Reuse R129's two retained takes for each of `think/sink`, `rice/lice`, `very/wary`, and
     `ship/sheep`, collected across two sessions, then add two deliberate `tink` recordings labeled
     as `/t/` substitutions for `think`.
   - For every take, manually mark only the contrasted phone interval and actual phone. Keep the
     recordings in app-owned/local evaluation storage, not in git; commit a manifest template,
     expected phone sequences, labels, and SHA-256 values only when the recordings are explicitly
     approved as fixtures.
   - Evaluate each minimal-pair recording both against its own pronunciation and against its paired
     target. This makes the same raw audio prove whether the unconstrained phone evidence follows the
     sound rather than the expected word.

3. **Run the model and conversion bake-off before app integration.**
   - Pin every downloaded checkpoint and vocabulary by repository revision and SHA-256. Keep model
     binaries out of git while spiking.
   - Establish the fp16 result first, then run Q4F16, Core ML 8-bit, and Core ML 4-bit over the exact
     same normalized samples. Record file size, cold-load time, inference time, peak resident-memory
     delta, phone winners, posterior margins, and aligned boundaries.
   - Prefer Core ML if conversion is supported and its evidence passes. Add ONNX Runtime to the iOS
     project only if Core ML fails fidelity or device performance. Before either conversion tooling or
     ONNX Runtime is pinned as a dependency, re-run dependency maintenance and supply-chain checks;
     their current release cadence does not silently clear the repo's dependency-vetting bar.

4. **Select by contrast evidence and device cost, not by model-card accuracy.**
   - On the 16 minimal-pair takes, the actual contrasted phone must beat the paired competitor within
     the labeled interval in at least 14 takes. Both `tink` takes must rank `/t/` above `/θ/`.
   - Median boundary error against the manual interval must be at most 40 ms and the 90th percentile
     at most 100 ms. A compressed candidate must preserve the fp16 key-phone winner on at least 17 of
     18 takes and move aligned boundaries by no more than 40 ms at the 90th percentile.
   - On the physical iPhone used for acceptance, record the hardware and build identity, require a
     model asset no larger than 220 MiB, peak resident-memory growth no larger than 400 MiB, cold load
     no longer than 3 seconds, and analysis of a five-second take no longer than five seconds.
   - Reject a candidate if its target inventory collapses a required contrast, it exposes only a
     forced target path without competing-phone logits, its result changes when STT metadata is
     withheld, its license/provenance is incomplete, or any resource gate fails.

5. **Integrate the selected analyzer with saved attempts without bloating metadata.**
   - Store bounded derived output as an atomically replaced `phone-evidence.json` beside
     `audio.caf` and `metadata.json`, keyed by the audio and model hashes. Do not store all 392 logits
     for every frame and do not copy raw audio.
   - Reanalysis replaces stale evidence when either hash changes. Missing assets, unknown target
     words, mapping mismatches, and inference failures remain visible errors. Existing directory
     deletion removes audio, metadata, and phone evidence together.
   - Extend saved-take Review to show the target phones, observed top phone, two or three competitors,
     posterior values, and start/end times. Label this as raw model evidence, not a correctness score.

6. **Verify and promote.**
   - Unit-test pronunciation lookup, vocabulary coverage, CTC collapse/alignment, top-K retention,
     evidence encoding, stale-hash replacement, deletion, and the invariant that phone analysis has
     no STT input.
   - Run the offline fixture bake-off, focused client tests, and `just check`; self-review the complete
     cross-file diff. Then stop at the device checkpoint and state the exact authorized run needed for
     the resource and physical evidence gates.
   - Flip R130 to D130 only when one pinned model/runtime/pronunciation-source combination passes every
     evidence, provenance, size, memory, latency, persistence, and physical-device gate above.

### R130 implementation checkpoint — 2026-07-25

- The integrated candidate is the iOS 26 Core ML ML Program generated by
  `just voice-phone-model`: 4-bit k-means LUT weights, per 16-channel group, from conversion
  revision `834e7279c06dbf822061b0fd5b44ec122b4a0aae`. The generated package is 159,837,430
  bytes; its weight SHA-256 is
  `8c093d09a94c89898670734440b18432f3229e7a9e5174f1fe3c159898fa172c`. The source,
  and its model-specification SHA-256 is
  `44629ea3d97747f6d80b8ebb906b5ddfabc301bdc6f565e5ed1bb625d46f34f4`. The source,
  vocabulary, conversion, output hashes, iOS 26 tensor contract, and 220 MiB size gate are checked
  by the reproduction script before Xcode sees the gitignored resource.
- The separately pinned Sadda fp16 ONNX reference is revision
  `fce273e5ab08dcc6090fdf51b5893cf76b038e70`, model SHA-256
  `35c2f8484b74737c7816e8762c095d6f7dc40ded7c36d249c8134d8f30d717b4`. Across the
  18 two-voice TTS smoke takes, the uncompressed Core ML export matched all 18 contrast winners,
  every per-frame argmax, and every forced-alignment boundary. This closes the conversion-provenance
  check but is not learner-speech acceptance evidence.
- The conversion bake-off rejected Core ML linear 4-bit at 13/18 preserved winners and 121 ms p90
  boundary drift; rejected 32-channel LUT4 at 16/18 despite 20 ms p90 drift; and rejected Core ML
  8-bit on its 302 MiB size before fidelity testing. ONNX Community Q4F16 preserved 17/18 winners
  with 0 ms p90 boundary drift only when graph optimization was disabled; the ordinary ONNX Runtime
  1.24.2 CPU session failed during graph initialization, so it was not selected. The chosen
  16-channel LUT4 preserved 17/18 winners with 0 ms median and 20 ms p90 boundary drift.
- The same synthetic smoke set gave the fp16 reference 13/16 intended minimal-pair winners and both
  deliberate `tink` winners. That result is diagnostic only: synthetic TTS is not a substitute for
  the 18 manually labeled retained iPhone takes or their contrasted-phone intervals.
- The client now reads only saved `audio.caf` plus a pinned CMUdict pronunciation, runs Core ML off
  the main actor, retains 199 top-five frames and forced target alignments in atomic
  `phone-evidence.json`, replaces stale output by audio/model hash, and displays target phones,
  observed phones, three competitors, log posteriors, margins, timing, hashes, and inference
  metrics inside saved-take analysis. It deliberately emits no pronunciation percentage and has no
  STT field in its analyzer request.
- The analyzer mirrors every bounded stage into the client's durable diagnostics NDJSON before
  entering the stage and atomically replaces each take's `phone-analysis-log.json`. Both files
  exclude audio and contain attempt/model identity, timestamps, resident-memory snapshots, and
  bounded stage details. `just voice-phone-logs-pull` retrieves current and prior unclean-run stages
  through the authenticated active-session or foreground tailnet path, so it works over mobile data
  after the killed app is reopened. `just voice-phone-evidence-pull` remains the local CoreDevice
  route: it does not require a live host session and copies only the file inventory plus
  `metadata.json`, `phone-analysis-log.json`, and `phone-evidence.json` (never `audio.caf`). It
  prints missing, failed, stale, or completed per-take evidence with aligned phones. Together these
  routes leave the last entered stage available even when no final phone evidence exists.
  The device-container inspection that motivated the command found two retained `think` takes on
  2026-07-25 with completed recognition metadata and no `phone-evidence.json`, proving phone
  analysis had not produced output for either take rather than the UI merely hiding a completed
  result.
- The first physical raw-audio analysis then failed before inference because the upstream JSON
  vocabulary contains both decomposed `u` plus combining tilde at token 191 and precomposed `ũ` at
  token 374. Swift `String` dictionary keys canonically equated them and collapsed the 392-token
  model contract to 391 entries. Generated client vocabulary is now an ID-ordered array, while
  reverse lookup keys exact Unicode scalar sequences, so all 392 model logits retain their original
  token IDs; the generator pins the transformed resource hash and the regression test covers that
  exact pair.
- iOS 26.5 simulator verification at exact client build `6fa76a77` then fixed the post-inference
  crash on Core ML's padded `[1, 199, 392]` output. The analyzer now reads logits by logical
  coordinates instead of passing stride-derived storage offsets to the bounded `NSNumber`
  subscript, and a custom-stride regression test pins that case. All three saved synthetic smoke
  takes reached `analysisCompleted`, retained `phone-evidence.json`, and rendered the evidence
  inline: `think` observed `/θ/`, `sink` observed `/s/`, and deliberate `tink` against target
  `think` observed `/t/` over `/θ/` with a `-3.76` target margin. This proves the on-device raw-audio
  path and contrast visibility, not learner-speech acceptance.
- Software gates are green: the generated-asset check, Python reproduction-script compile, all 404
  client simulator tests across 43 suites, and repository-wide `just check` (583 host tests across
  76 suites plus its package, web, and build gates).
- Remaining before D130: use `just voice-phone-device-run` after the device checkpoint, collect and
  manually interval-label the 16 retained minimal-pair takes plus two deliberate `tink` takes from
  `client/voice-phone-fixtures/manifest.template.json`, meet the 14/16 plus 2/2 phone gates and the
  40/100 ms boundary gates, then measure cold load, five-second analysis, and peak RSS on the named
  physical iPhone. The in-app observed RSS delta is a checkpoint sample, not a claim about peak
  memory; physical peak acceptance still needs the device measurement.

## v15 Phase 1.1: host-retained client telemetry

- R137. Make the Mac retain enough authenticated client evidence during and immediately after a
  session to diagnose a missing rail, missing video, or client crash without `devicectl`, an attached
  console, Wi-Fi, or a later manual pull while the iPhone remains foregrounded.

### R137 evidence boundary

- Host observations remain authoritative for session authentication, lane readiness, capture,
  encoding, datagram sends, frame acknowledgements, and disconnect timing. The existing unified-log
  categories remain the high-rate media record; do not duplicate every frame or quality window into
  a second store.
- The host cannot infer UIKit presentation from a frame acknowledgement. The client must explicitly
  report bounded state transitions for scene phase, pairing state, active surface, rail visibility
  and configured host-backed buttons, media startup, first complete frame, first decoder enqueue,
  and first presentation attempt. A missing checkpoint means "not observed," never "did not happen."
- Telemetry is operational metadata only. It must not contain raw audio, transcripts, target phrases,
  terminal or editor content, keystrokes, screenshots, pairing material, URLs, model logits, or
  arbitrary caller-supplied fields. Use fixed enums, booleans, counters, build identity, run/session
  identifiers, and bounded error codes.
- Client durable diagnostics remain the client-side source of truth. Host retention is an
  authenticated cache of client-produced evidence plus a correlation index, not a second mutable
  client history.

### R137 execution plan

1. **Add a bounded client runtime checkpoint contract.**
   - Add an additive `client-runtime-checkpoint` frame in `AgentDeskWire` with schema version,
     client run ID, monotonic sequence, client timestamp, marketing version, build number, git SHA,
     scene phase, pairing state, active surface, rail configured/hidden/layout-ready state,
     host-backed surface count, media state, and the latest video milestone.
   - Emit checkpoints only on state transitions and deduplicate identical snapshots. Record the same
     checkpoint into `ClientDiagnosticsStore` before enqueueing its best-effort send so a transport
     failure cannot erase the local evidence.
   - Take the UI checkpoint after `render()` and after the first completed layout pass. Add media
     milestones at transport scheduled/started, first complete frame, first decoder enqueue, and
     first presentation attempt. Keep these hooks observational; telemetry failure cannot change
     session, UI, or media behavior.

2. **Give diagnostics traffic one host-side consumer and request router.**
   - Replace ad hoc iteration over `InputChannelServer.diagnosticsUpdates` with one per-session
     diagnostics broker. It alone consumes the stream, routes matching request IDs to pending manual
     or automatic collectors, and handles unsolicited `announce-*` summaries.
   - Preserve concurrent manual `just client-diagnostics` requests without letting an automatic
     announcement consumer steal their summary or chunks. Cancel pending continuations when the lane
     closes and fail them with the actual closure reason.

3. **Automatically ingest client runs while the app is already foregrounded.**
   - On every authenticated input-lane attachment, have the client announce the current run and any
     not-yet-confirmed archive summaries, not only prior unclean runs.
   - Compare run ID, byte count, and event count with the host cache. Immediately request only new or
     advanced bounded tails through the live session, before the user can background the app.
   - Atomically store received summaries and compressed NDJSON under the bundle-scoped host
     Application Support directory, partitioned by device fingerprint and run ID, with `0700`
     directories, `0600` files, bounded total size, and oldest-run rotation. Mark an archive
     delivered only after the host has durably replaced its cached copy.

4. **Persist a low-rate host correlation index.**
   - Add a bounded host session index containing host receive time, device fingerprint, session ID,
     client run/build identity, lane-ready/closed markers, first frame sent/acknowledged markers,
     client checkpoint transitions, automatic-ingest status, and the final disconnect reason.
   - Route existing lifecycle seams into this index rather than parsing prose logs at write time.
     Keep high-rate encoder, repair, and quality telemetry in unified logging and retain timestamps
     that let the exporter select the matching window.

5. **Export one self-contained incident bundle.**
   - Add `just host-client-telemetry <variant>` that performs no device operation. It exports the
     newest or requested client run to `/tmp/agentdesk-host-client-telemetry-<timestamp>/` with a
     machine-readable timeline, cached client NDJSON, client/build identity, and the bounded matching
     host unified-log window.
   - Summarize the decisive milestones explicitly: session ready, rail checkpoint, media started,
     first frame sent, first frame acknowledged, first frame completed, first frame enqueued,
     presentation attempted, scene backgrounded, lane closed, and prior-run clean/unclean status.
     Preserve raw artifacts beside the summary so the command never substitutes an inference for
     evidence.

6. **Verify failure and non-failure paths.**
   - Unit-test wire round trips and size bounds, checkpoint deduplication, privacy field allowlisting,
     diagnostics broker routing under overlapping automatic/manual requests, lane-close cancellation,
     cache atomicity/deduplication/rotation/permissions, and incident timeline classification.
   - Run focused client, host, and wire tests plus `just check`, then stop at the physical-device
     checkpoint. After explicit approval, verify a normal foreground/background cycle and one killed
     phoneme-analysis run. Reopen the app once, leave it foregrounded only long enough to reconnect,
     then prove `just host-client-telemetry stable` still returns both runs after the phone is
     backgrounded.
   - R137 is complete only when the host bundle can distinguish: transport never connected; rail was
     configured but hidden; frame reached the client but was not enqueued; frame was enqueued but no
     presentation attempt was observed; clean background; unclean exit; and telemetry itself ended
     before the decisive boundary.

### R137 implementation status

- Implemented the fixed, content-free runtime checkpoint contract and client persistence/send path;
  the control rail lays out before media startup, and video receive, decoder enqueue, and presentation
  attempt transitions are retained independently.
- Implemented one diagnostics broker per authenticated input lane, automatic current/archive run
  ingestion, secure bounded host storage, the durable correlation timeline, and
  `just host-client-telemetry <variant>`.
- A caught phoneme-analysis result now advances the live host cache immediately. An OOM or other hard
  termination remains uncatchable in-process; the next launch records the prior unclean run and
  MetricKit crash metadata, then announces both after reconnect.
- Manual iOS 26.5 simulator verification at `5f5f986b` observed all six rail controls, including the
  terminal button, before the first video frame. The deterministic test pattern and real
  ScreenCaptureKit source then both rendered visibly. This run also caught and fixed the rail-first
  late-mount regression that had left the video sink at zero extent while frames still decoded.
- Green gates: 41 wire tests, 31 client XCTest cases, 402 client Swift Testing cases, 583 host tests,
  the exporter fixture, and `just check`.
- Remaining before D137: the explicitly authorized physical-device normal lifecycle and killed
  phoneme-analysis verification in step 6.

## v15 Phase 2: calibrated pronunciation score

- R131. Derive a GOP or equivalent per-phone margin from R130's posterior evidence, preserve the
  underlying target and competing-phone values beside every score, and calibrate any learner-facing
  scale against labeled non-native speech before displaying it; do not ship an arbitrary distance
  transformed into a percentage.

### July 2026 decision baseline

- R130's `posteriorMargin` is the first candidate, not an accepted score. It is the duration-normalized
  target log posterior minus the strongest unrestricted competing phone over a forced target range.
  The raw target, observed phone, competitors, range, and model hashes remain authoritative even if a
  later calibration changes.
- Evaluate score extraction with the selected R130 model before considering another acoustic
  backbone. The three candidates are: the existing aligned posterior margin; an aligned pre-softmax
  logit margin computed while the full model output is still in memory; and an alignment-free CTC
  canonical-sequence margin whose denominator permits every phone in a pinned US-English assessment
  inventory plus deletion at the assessed phone. Keep R130's all-model-vocabulary competitors as raw
  evidence, but do not let unrelated multilingual tokens define the calibrated denominator. Do not
  persist the full 199 x 392 tensor, add a learned neural scoring head, or use STT, synthesized
  reference audio, speaker embeddings, or attempt history in this phase.
- Standard CTC's blank-heavy, peaky output and target-conditioned segmentation are explicit risks.
  The score bake-off must measure blank ratio, effective non-blank support, boundary/score stability,
  and deletion behavior. A forced alignment that produces a number for every target phone is not
  evidence that the number is trustworthy.
- Use the official SpeechOcean762 train/test split as the only source of shipping calibration
  coefficients. It contains 5,000 utterances from 250 Mandarin-L1 English learners, independently
  scored by five experts at phone, word, and utterance levels, and is CC BY 4.0. Its Mandarin-L1 and
  child/adult mix are part of the calibration provenance and prevent a claim of universal correctness.
  Corpus audio stays in a gitignored local cache; only the pinned source revision/hash, mapping,
  aggregate metrics, and selected small calibration manifest may enter the repository.
- Use L2-ARCTIC v5 only as a non-shipping robustness evaluation. Its 3,599 manually annotated
  utterances cover substitutions, deletions, and additions from 24 speakers across Hindi, Korean,
  Mandarin, Spanish, Arabic, and Vietnamese L1 groups, but its CC BY-NC 4.0 license means no shipped
  coefficient or threshold may be fit or tuned on it. R130's retained 18-take matrix remains a
  personal contrast check and never becomes calibration training data.
- Current primary sources inspected on 2026-07-26:
  [Li et al., BEA 2026, published 2026-07-03](https://aclanthology.org/2026.bea-1.3/)
  documents standard CTC peakiness, timing instability, and the effect on GOP;
  [Cao et al., Interspeech 2024](https://www.isca-archive.org/interspeech_2024/cao24b_interspeech.html)
  defines alignment-free CTC GOP and shows why deletion-aware denominators matter;
  [Parikh et al., Interspeech 2025](https://www.isca-archive.org/interspeech_2025/parikh25_interspeech.html)
  evaluates unrestricted and phonologically restricted substitution sets;
  [OpenSLR SLR101](https://www.openslr.org/101/) is the authoritative SpeechOcean762 license and
  distribution page; and the
  [official L2-ARCTIC v5 page](https://psi.engr.tamu.edu/l2-arctic-corpus/) documents its speakers,
  annotations, and access terms. Older GOP work is historical context, not authority for the selected
  iOS 26 implementation.

### R131 execution plan

1. **Freeze the score feature and provenance contracts.**
   - Add a pure `VoicePronunciationScorer` boundary that consumes only `VoicePhoneEvidence` plus a
     pinned `VoicePhoneCalibrationManifest`. Its output is versioned per aligned phone and carries the
     evidence index/hash, feature-version identifier, all candidate raw margins, selected candidate,
     calibrated expected expert grade on the corpus's native 0-to-2 scale, support status, and an
     abstention reason when a score is not justified.
   - Extend the analyzer only enough to emit bounded per-phone pre-softmax target/competitor aggregates
     and alignment-free canonical/substitution/deletion log probabilities while the logits are already
     resident. Keep the existing posterior target and competitors unchanged and never retain the full
     tensor.
   - Persist the derived result atomically as `phone-assessment.json` beside `phone-evidence.json`,
     keyed by the audio, evidence, model, vocabulary, feature, and calibration-manifest hashes.
     Recalibration reads retained evidence and replaces only the assessment. A stale or mismatched hash
     is a visible abstention, and deleting an attempt removes audio, evidence, assessment, and logs
     together.

2. **Build a reproducible, speaker-disjoint calibration harness.**
   - Add one offline recipe that downloads the official SpeechOcean762 artifact into
     `.build/voice-phone-calibration`, verifies its license, revision and SHA-256, preserves the
     upstream speaker-disjoint train/test split, and records duration, phone-label, age-group, gender,
     and phone-inventory coverage before running inference.
   - Expand ARPABET-to-model-phone conversion in one shared generated mapping. Every stressed phone
     must map to an exact R130 token ID. Unknown symbols, utterances that cannot fit the model's
     four-second tensor contract, and labels without enough acoustic coverage are excluded with
     counted reasons rather than silently cropped or coerced.
   - Run the exact selected Core ML package and preprocessing contract on macOS. Pin Python/Swift
     parity fixtures for audio normalization, CTC forward probability, aligned aggregation, candidate
     features, and calibration output so the offline evaluator and iPhone cannot drift.
   - Define a supported-phone set from training data only: at least 100 scored training instances,
     20 held-out instances, and coverage of both below-1.0 and at-least-1.5 expert grades. R131 cannot
     cover the current product matrix unless `/θ s ɹ l v w ɪ iː/` all pass this support gate.

3. **Bake off score candidates without looking at held-out labels.**
   - Compare the aligned posterior margin, aligned logit margin, alignment-free substitution margin,
     and alignment-free substitution-plus-deletion margin on SpeechOcean762 training folds grouped by
     speaker. For each candidate report phone-level Pearson and Spearman correlation, mean absolute
     error after calibration, at-most-0.5-versus-at-least-1.5 AUROC, score distributions by phone and
     speaker, and blank/effective-frame diagnostics.
   - Fit only a monotonic scalar calibrator on training data. Prefer a global isotonic mapping that can
     be exported as bounded knots; add phone-specific mappings only when their predeclared support gate
     passes and they improve speaker-fold error without reversing monotonicity. No runtime ML or
     statistics dependency ships in the app.
   - Select the simplest candidate within 0.02 Pearson correlation and 0.02 grade MAE of the best
     training-fold result. The final candidate, mappings, phone support set, bands, and all thresholds
     freeze before the official test labels are opened.

4. **Gate calibration, robustness, and abstention on untouched evidence.**
   - On the official SpeechOcean762 test split require phone-level Pearson and Spearman correlation of
     at least 0.50, grade MAE no greater than 0.35 on the 0-to-2 scale,
     at-most-0.5-versus-at-least-1.5 AUROC of at least 0.80, and equal-count-bin calibration error no
     greater than 0.10 after normalizing the grade to 0-to-1. Bootstrap by speaker; the 95% lower
     Pearson bound must remain at least 0.45.
   - Report every metric overall and by supported phone, adult/child group, and gender. A phone is
     removed from the shipping support set if its held-out correlation is inverted, its MAE exceeds
     0.50, or either expert-grade side has fewer than 10 test instances.
   - Freeze the SpeechOcean-derived threshold, then run L2-ARCTIC without tuning. Require overall
     substitution/deletion AUROC of at least 0.70, no L1 group below 0.55, and no worst-group recall
     more than 20 percentage points below Mandarin at the frozen threshold. Failure keeps the score
     explicitly Mandarin-calibrated or blocks learner-facing display; it never triggers threshold
     tuning on the non-commercial corpus.
   - On R130's 18 retained takes, the two correct `think` takes must score above both deliberate
     `tink`-as-`think` takes, the actual phone must remain the leading contrasted hypothesis in the
     accepted 14-of-16 plus 2-of-2 matrix, and gain changes of plus/minus 6 dB or 200 ms edge silence
     must not change the selected phone or move the calibrated grade by more than 0.20. Low effective
     support, unsupported phones, clipping, or an out-of-domain calibration must return no score.

5. **Integrate an honest per-phone result into saved-take Review.**
   - Show the calibrated estimate as an expected expert phone grade rounded to one decimal on the
     native `0.0–2.0` scale, paired with `Needs attention`, `Close`, or `Clear` bands frozen in the
     calibration manifest. Keep target phone, observed phone, strongest competitors, raw selected
     margin, time range, calibration corpus, and support/abstention state visible in the same phone row.
   - Do not show a percentage, phrase average, pass/fail verdict, reference similarity, or improvement
     claim in Phase 2. Unsupported or low-evidence phones retain the complete raw R130 evidence and say
     why no calibrated estimate is available.
   - Add re-score and stale-calibration handling without rerunning Core ML when the evidence contract is
     current. Analysis remains off the main actor; scoring failure cannot destroy raw evidence or make
     replay, deletion, STT analysis, or the Voice/video surface switch unavailable.

6. **Verify, self-review, and promote only after physical evidence.**
   - Unit-test feature formulas, blank/special-token exclusion, substitution/deletion forward sums,
     calibration monotonicity and bounds, hash invalidation, unsupported-phone abstention, atomic
     persistence, deletion, offline/iPhone parity fixtures, and the invariant that scoring accepts no
     transcript, reference audio, speaker identity, or history input.
   - Run the pinned corpus harness, held-out reports, focused client tests, `just check`, and the full
     client simulator suite. Self-review the evidence-to-score-to-UI path, generated asset provenance,
     privacy boundary, and every failure state.
   - Stop at the device checkpoint. After explicit approval, update the current stable client in place,
     re-score the retained physical matrix, verify a supported score and an abstention in Review, pull
     the persisted evidence/assessment, and confirm replay/delete plus host/video return paths still
     work. Flip R131 to D131 only when the corpus, cross-L1, perturbation, personal contrast, persistence,
     and physical UI gates all pass.

### R131 implementation checkpoint (2026-07-26)

- Implemented the versioned R131 evidence features, deterministic CMUdict/model-phone mapping,
  pure calibrated scorer with provenance and abstention, atomic assessment sidecar, stale-evidence
  re-score, and saved-take Review presentation. Scoring consumes only retained R130 evidence and the
  pinned calibration manifest; transcript, reference audio, speaker identity, and history remain
  outside its input contract.
- Ran exact Core ML inference over all 2,500 SpeechOcean762 training utterances and all 2,500 official
  test utterances. The training-only choice froze as `alignmentFreeSubstitutionMargin` before test
  evaluation. On 7,604 held-out product-phone rows it produced Pearson `0.275`, Spearman `0.246`,
  MAE `0.106`, AUROC `0.874`, calibration error `0.0046`, and speaker-bootstrap Pearson lower bound
  `0.247`.
- The frozen candidate fails the predeclared overall correlation gates and only `/s l ɪ iː/` pass every
  per-phone population gate. The committed manifest therefore contains no coefficients or support
  claims, `displayEnabled` remains false, and Review keeps the raw phone evidence while stating why
  no calibrated estimate is available.
- Verification is green for the 8-test offline formula/provenance suite, 17 focused iOS scoring and
  persistence tests, the full 415-test client simulator suite, and `just check` including all 583 host
  tests. The report recipe exits `2` by design because the learner-facing release gates did not pass.
- Researched publicly inspectable pronunciation scorers and phone representations through 2026-07-26.
  Li et al.'s July 2026 context-aware CTC with GOPT reports `0.641` phone PCC versus `0.612` for
  standard GOPT; its HierCB table reaches about `0.636` with WavLM while the Kaldi TDNN-F baseline
  remains `0.660`. The paper links component implementations, and the related
  [CTC-based-GOP repository](https://github.com/frank613/CTC-based-GOP) publishes score-extraction
  code, but no complete released checkpoint was found, so those results are not locally validated.
  ConPCO/HierCB publishes training code but no checkpoint. The March 2026
  [Jianshu001/wavlm-phoneme-scorer](https://huggingface.co/Jianshu001/wavlm-phoneme-scorer)
  raw-audio checkpoint claims `0.645` phone PCC, but has private training data, a
  non-speaker-disjoint split, zero recorded downloads, no linked publication, and an inference script
  that disables safe weight-only loading; it is not an authoritative candidate.
- Added a pinned, isolated Mac reproduction for the official BSD-licensed GOPT LibriSpeech scorer.
  On the M2 Pro CPU with PyTorch `2.13.0`, its untouched SpeechOcean762 test features reproduced
  `0.618` phone Pearson, `0.438` Spearman, and `0.083` MSE over 47,369 phones in about one second.
  This reproduces the published Pearson result and clears the Pearson and error gates, but fails
  R131's `0.50` Spearman gate. It also does not validate a replacement for Agent Desk's raw-audio
  path: GOPT requires an 84-value Kaldi TDNN GOP vector per phone while R131's calibration surface
  offers four scalar CTC candidate margins. CPU and Apple Metal both reproduced the same metrics in
  about one second for this 120 KB scorer, so accelerator availability is not the blocker. The
  benchmark therefore records `passesScorerGate=false`,
  `rawAudioReplacementValidated=false`, and `appGradeEnableAuthorized=false`.
- Remaining before D131: choose and validate a stronger acoustic representation without tuning on the
  official test split, run the user-licensed L2-ARCTIC cross-L1 gate, rerun the R130 personal contrast
  and perturbation matrix, then complete the explicit physical-device Review/persistence checkpoint.

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
  the device checkpoint; after explicit approval, update the current client in place and verify recording,
  replay, deletion, phoneme evidence, reference comparison, and history on the physical iPhone with
  matching build identity.

## v15 Phase 7: open-passage phoneme comparison

- R138. Add an independent `Passage` tab beside the existing target-practice probe. Record up to two
  minutes without a supplied target, retain every lossless take and its metadata in a recordings
  library, and let a selected recording be replayed, edited, deleted, and reanalyzed from the same
  saved audio after navigation or relaunch. Transcribe without context injection and present exactly
  three long-form cards in recording detail: editable transcript, unconstrained phones decoded from
  the raw audio, and reference phones generated from the edited transcript. Keep the two phone
  sequences separate and visible; do not present them as aligned, scored, or proof of pronunciation
  correctness. Include a deterministic bundled recording that exercises the same raw-audio path in
  simulator verification without depending on simulated microphone speech.
- R139. Group both Passage phone cards by transcript word. Reference groups come directly from
  CMUdict word pronunciations. Because the raw model does not emit word boundaries, assign its flat
  phone stream with an explicitly labeled transcript-guided sequence alignment, retain every inserted
  phone, and expose an unassigned group when no dictionary anchor exists. Persist the grouped result
  so reopening a saved recording does not collapse back to a flat stream.

### R138 implementation checkpoint (2026-07-26)

- Added the tab without replacing the R128-R131 target-practice UI. Switching modes suspends the
  inactive recorder and preserves an interrupted Passage take instead of discarding it; analysis of
  an already-finished take continues while its tab is hidden.
- Passage capture uses the existing iOS 26 SpeechAnalyzer path for unaided transcription. Raw-audio
  phone decoding runs the pinned Core ML CTC model over consecutive four-second windows for recordings
  up to 120 seconds, merges only an identical adjacent chunk-boundary phone, checks cancellation
  between windows, and writes the existing durable analysis checkpoints with `analysisMode=passage`.
- Passage is a two-level recordings UI: the first level contains the recorder, bundled samples, and
  every saved learner take; the second level opens one immutable audio file with Back, Play,
  Reanalyze, Delete, and the three comparison cards. Each take owns a UUID directory containing
  lossless CAF audio plus atomically written metadata. Reanalysis always reads that file. The latest
  speech-recognizer result is retained separately so it cannot overwrite a transcript the learner
  explicitly edited.
- The bundled `Thought about the quiet garden` sample is 16 kHz mono Float32 CAF and is seeded
  idempotently into the same recording store. `voice-passage-sample.yaml` opens it, invokes the real
  raw Core ML passage analyzer, verifies the placeholder disappears, replays it, and returns to the
  library. Passage capture falls back to that same analyzer format when SpeechTranscriber is
  unavailable, so simulator capture is no longer disabled solely because transcription is absent.
- Reference phones use the pinned CMUdict revision
  `74790861f652b15e4ac49015a90074ad62a27690` bundled with its BSD license. The app verifies dictionary
  SHA-256 `81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22`,
  maps stress-insensitive ARPABET through the same generated model-phone inventory, keeps the first
  listed pronunciation, and exposes unknown words rather than guessing.
- Added focused coverage for long transcript tokenization/reference generation, the real pinned
  dictionary asset, adjacent chunk merging, multiple independent lossless recordings, sample seeding
  and audio format, per-recording deletion, and the two-level three-card UI contract. The correction
  passed `just check-all`: 583 host tests and 425 client tests, plus all package, web, and Rust gates.
- Manually verified the committed `b7d8a9a4` host and client on iPhone 17 / iOS 26.5 with
  `voice-passage-sample.yaml`. A fresh reanalysis was observed from start through saved completion,
  retained 27 raw-audio phones and 29 reference phones with no phone-analysis failure, replayed the
  saved sample to completion, and returned to the recordings library. The analyzed CAF retained
  SHA-256 `3a44aad26dac579913f4a2e581012435b1139c7d15c980992f63950a575b7b6c`,
  identical to the bundled source. `SpeechTranscriber` remains unavailable in this simulator, so
  real-device saved-file transcription is not covered by this drive.

### R139 implementation checkpoint (2026-07-26)

- Added a pure global edit-distance grouper over the raw and reference phone sequences. Reference
  tokens retain their transcript-word index; raw insertions attach to the nearest aligned word,
  deletions remain visible as missing raw phones within their reference word, and an explicit
  `Unassigned raw phones` group preserves evidence when the transcript has no known pronunciation.
- Stored the optional word-group result beside the unchanged flat evidence. Existing schema-1
  recordings remain readable and regenerate groups when opened; transcript edits recompute both the
  reference groups and the raw-to-reference grouping without rerunning the audio model.
- Both phone cards now render word-plus-phone groups inline with transcript-like spacing and natural
  width-based wrapping, rather than fixed rows or a fixed group count per line. The heard card says
  `Transcript-aligned` so the UI does not misrepresent the grouping as an acoustic word boundary.
- `just check-all` passed with 583 host tests, 428 client tests, and every package, web, and Rust
  gate. The final alignment self-review added nearest-anchor coverage and the client suite then passed
  with 429 tests across 50 suites.
- Manually verified the committed `086befa8` host and client on iPhone 17 / iOS 26.5 with
  `voice-passage-sample.yaml`. Reanalysis completed, saved-recording playback completed, and the app
  returned to the recordings library without exiting. The screenshot shows transcript-word phone
  groups flowing inline and wrapping only at available-width boundaries, with no fixed groups per
  line. Persisted metadata contains all 8 transcript words, preserves the flat heard sequence exactly
  (27 grouped phones = 27 raw phones), and preserves the reference sequence exactly (29 = 29). The
  analyzed CAF remains byte-identical to the bundled source. `SpeechTranscriber` is unavailable in
  this simulator, so real-device saved-file transcription remains outside this drive.

## v15 Phase 8: selectable phone-recognizer bakeoff

- R140. Add a persisted phone-model chooser to each saved Passage recording so the same immutable
  audio can be reanalyzed with either the existing compressed Core ML wav2vec2 model or a second,
  materially different pretrained phone recognizer. Keep successful-result provenance separate from
  the latest attempted model, retain old visible phones when another model fails, pin and verify every
  downloadable runtime asset, and make ZIPA the default while the two models are compared. This is an
  A/B evidence surface, not a pronunciation score or a claim that either raw phone sequence is correct.

### R140 implementation checkpoint (2026-07-26)

- Added a native segmented ZIPA / wav2vec2 chooser to saved Passage detail. The choice persists in
  `UserDefaults`, disables during analysis, and is captured when Reanalyze begins so a mid-run UI
  change cannot alter the active model. New recordings use ZIPA by default. Metadata stores the model
  that produced the visible phones and the most recently attempted model separately; a failed model
  run keeps the previous successful model, timestamp, weight hash, and phone sequence intact.
- ZIPA runs locally through Microsoft's official `onnxruntime` Swift package pinned to 1.24.2. The
  `anyspeech/zipa-small-crctc-ns-700k` INT8 graph, token inventory, and upstream MIT license are fetched
  only from immutable revisions, staged as generated resources, and checked against pinned byte counts
  and SHA-256 values before simulator tests, installs, or release archives. The app repeats the
  manifest, token, model-size, and model-hash checks before creating an inference session.
- Implemented the model's 16 kHz, 80-bin Lhotse/Kaldi-style filterbank frontend and CTC decoder.
  Passage audio is read to its declared frame count instead of assuming one `AVAudioFile.read` call is
  complete, split into 12-second windows with 0.4-second overlap, and merged without discarding new
  phones. ZIPA character tokens are joined into the same IPA-like phone units used by the reference
  card, while the existing wav2vec2 path remains unchanged behind the same result contract. The ZIPA
  session is released after each analysis, cancellation is honored between chunks, and durable start,
  model-load, chunk, cancellation, completion, and failure checkpoints survive a client crash or kill
  for later on-demand diagnostics.
- Focused simulator tests exercise selector persistence and layout, asset verification, frontend
  parity, CTC and overlap behavior, and the real bundled ONNX graph. The saved garden sample decoded
  the same 29-phone sequence as the upstream Python inference check. `just check-all` passed with
  583 host tests, 436 client tests, and every package, web, and Rust gate. A manual simulator or
  physical app drive remains at the explicit run checkpoint, so chooser interaction and comparative
  output have not yet been visually accepted.
- Current evidence through July 2026: the pretrained alternative is grounded in the
  [ZIPA ACL 2025 paper](https://aclanthology.org/2025.acl-long.961/) (published July 2025)
  and its [published model repository](https://huggingface.co/anyspeech/zipa-small-crctc-ns-700k)
  (no publication date verifiable);
  Microsoft's [Swift package release 1.24.2](https://github.com/microsoft/onnxruntime-swift-package-manager/releases/tag/1.24.2)
  was published 2026-02-25. [PRiSM at ACL 2026](https://aclanthology.org/2026.acl-long.825/)
  (published July 2026) is relevant to the later pronunciation-scoring phase, but is not treated
  as a drop-in phone transcription runtime here.

## v15 Phase 9: host-owned shared voice recordings

- D141. Make the Python voice sidecar the single recording, transcription, and ZIPA-analysis
  authority for the shared Gesture/Voice InteractionPanel. Persist nonempty normal and interrupted
  sessions atomically with explicit source, stage failures, and executor provenance; reject a second
  active recorder immediately and permit analysis-only reanalysis from the retained WAV.
- D142. Add the additive authenticated `voice = 7` QUIC stream with its own `voice-lane-v1`
  negotiation, bounded typed envelopes, stale-request protection, a loopback WebSocket proxy, and a
  strict recording REST allowlist. Keep protocol v15 because existing peers and lanes remain
  compatible.
- D143. Bridge the iOS embedded InteractionPanel through native Swift to the voice lane while the Mac
  panel and browser development retain direct loopback transports. Transport loss must visibly fail
  the web run and cause Python to finalize any nonempty partial audio as interrupted.
- D144. Present the one host library on both panels with source and completion badges, transcript and
  phone-analysis failures, ZIPA provenance, host-WAV playback, deletion, and reanalysis. Stop releases
  the microphone immediately and exposes saving, transcription, and analysis stages.
- R145. Implementation and automated gates are complete. At the explicit runtime checkpoint, manually
  accept Mac, iPhone, disconnect, busy, and microphone/WebSocket/QUIC resource-cleanup behavior.
- D146. Give completed shared Voice recordings the native Passage reading mode: one transcript card,
  one ZIPA-phone card grouped against transcript words, and one CMUdict reference-phone card grouped
  by the same words. Derive grouping on the host from durable transcript and flat phone facts, retain
  every unanchored phone, expose unknown words and pinned dictionary provenance, and stage the same
  CMUdict/mapping assets into the installed Python sidecar.
- D147. Remove the nested recordings viewport from shared Voice so capture and saved passage results
  use one continuous WKWebView scroll surface on Mac and iPhone.
- D148. Add whole-passage and per-word reference speakers to shared Voice, using bounded local
  InteractionPanel requests and native TTS on Mac and iPhone without sending or retaining synthesized
  audio.
- D149. Retire the unaccepted native AVSpeech reference chooser while preserving the independent
  Agent Say catalog. Reference pronunciation must have one host-generated audio authority rather
  than different device voices and pronunciation inference.
- D150. Convert the exact pinned CMUdict reference shown by the Passage cards into stressed
  Kokoro-compatible IPA and send those tokens directly to pinned Kokoro-82M without constructing its
  text G2P. Generate one atomic, hash-verified host WAV cache keyed by text, IPA, voice, speed, model,
  dictionary, and mapping provenance. Let macOS play the loopback artifact and iPhone fetch the same
  WAV through bounded voice-lane REST chunks for temporary native playback. Keep voice and speed
  choices device-local, fail visibly on unknown words or missing symbols, and stop playback before
  capture or navigation.
- R151. At the explicit runtime checkpoint, accept first-use model preparation, passage and per-word
  playback, independent Mac/iPhone chooser persistence, byte-identical cross-device artifacts,
  unknown-word errors, cache reuse, and microphone/audio-session cleanup on Mac and physical iPhone.
- D152. Replace the all-Spaces macOS Dictation Bar's isolated Swift recorder with the compact
  `dictation.html` InteractionPanel entry. Browser capture sends `source=macos` through the existing
  loopback VoiceSocket and Python finalizer; Swift retains only window/Fn chrome, bundled-origin mic
  permission, and one final insertion per host recording ID. The same completed recording appears in
  the full Voice library, which the new top-bar Voice command opens directly after the mini run is
  terminal. ADR-0079 supersedes the retired `MicRecorder`/WAV/multipart path.
- D153. Add an iPhone Control-surface dictation sheet from the keyboard control. Reuse the native
  authenticated voice lane and host-owned recording finalizer, show the saved transcript in an
  editable field, and send only an explicit final edit through the existing remote-keyboard input
  path. Do not introduce a local PCM, on-device transcription, or a second text-injection protocol.
- D154. Add an optional Recording prefix section to the iPhone dictation review sheet. It composes the
  visible prefix with the reviewed transcript only for the explicit remote-keyboard send; it never
  mutates the host-owned recording or stored transcript.
- D155. Complete the Custom Keyboard extension spike: physical handoff and App Group return proved
  viable for the one-device internal TestFlight posture. Retire its nonce receipt, probe insertion,
  `keyboard-spike` route, and development naming rather than carrying a compatibility layer.
- D156. Replace the spike with Production AgentDesk Keyboard Dictation (ADR-0081). Ship a native
  en-US QWERTY that types without Full Access or a Mac, generation-fenced App Group service state,
  Automatic and Explicit Review insertion, app-owned background microphone capture, a bounded
  ordered role-7 audio queue, host-owned Whisper/ZIPA finalization, and exact `clientSessionID`
  reconciliation. Keep the existing video-path keyboard and manual dictation sheet unchanged.
- R157. At the explicit physical-device checkpoint, accept ordinary QWERTY without connectivity,
  one-time activation and swipe-back, repeated Automatic and Explicit Review takes, exact host
  recording correlation, other-audio mixing, busy/network/interruption/termination failures, and
  complete Turn Off cleanup. Do not claim public App Store safety for the containing-app Link.
- D158. Give the production keyboard one authoritative portrait and compact-landscape geometry,
  fixed-height Apple-adjacent rows, raised dynamic key tokens, visible press restoration, standard
  input clicks, optional device-local haptics, immediate nonduplicating delete repeat, cursor
  selection feedback, and conditional system input-mode switching. Keep the typing and voice
  transport contracts unchanged.
- R159. At the explicit physical-device checkpoint, compare AgentDesk with the Apple keyboard in
  light and dark appearance, verify uncompressed ready/inactive/review/recording layouts across
  rotation, confirm click and haptic settings independently, and confirm Face ID devices render
  only the system-owned globe.
- D160. Add the native-adjacent Character Preview visual to ordinary character keys using one
  bounded, edge-aware UIKit overlay. Show it on touch-down, clear it before insertion, cancellation,
  rerender, and ownership replacement, and keep it out of the accessibility and hit-testing trees.
- R161. At the explicit physical-device checkpoint, compare center and edge Character Preview
  placement with the Apple keyboard in portrait, landscape, light, and dark appearances, including
  rapid multi-touch, cancellation, shift, number, and symbol layouts.
- D162. Replace the generic lowercase Return label with the compact `↵` glyph while preserving
  field-specific action labels and the readable VoiceOver name.
- D163. Match the native alphabet geometry by centering A–L at the Q–P key width, widening the
  Shift/Z and M/Delete gutters, and leaving Space visually blank while preserving its accessible
  name.
- D164. Keep the armed Keyboard Dictation service usable inside AgentDesk instead of trapping the
  client behind its activation screen. Make activation dismissible, add an explicit **Use in
  AgentDesk** action that returns to the existing Control-surface keyboard field, publish service
  state to independent screen/root observers, expose persistent status and management through the
  control rail and Settings, and tear the service down with pairing or scene ownership. Final
  transcripts continue through the ordinary remote-keyboard input path; no second text transport is
  introduced.
- D165. Make long host Voice finalization independent of Whisper's previous-window text so a quiet
  tail cannot repeat the last decoded sentence. Apply the configured gain only to the final
  transcription input while preserving the authoritative raw WAV for storage and ZIPA. Preserve
  transcript casing through pronunciation tokenization and resolve unknown uppercase initialisms
  from CMUdict letter names, keeping direct-IPA whole-passage Kokoro playback available without
  falling back to text G2P.
- D166. Make shared Voice capture loss-detecting from microphone to Python. Flush and fence the
  browser worklet tail, fail visibly on capture or transport congestion, serialize iPhone bridge and
  role-7 writes through bounded queues, wait for the loopback WebSocket handshake before reporting it
  open, and negotiate `voice-lane-v2`. Sequence every PCM frame and fence Stop with the captured
  sample count; Python preserves any nonempty discontinuous take as interrupted with durable
  transport-audit metadata instead of presenting partial audio as complete.
- D167. Make the standalone iOS terminal own one durable keyboard responder. Reuse the existing
  `KeyboardSurface` and accessory controls without local echo, encode their key and sticky-modifier
  events through the shared xterm runtime, size the terminal above `UIKeyboardLayoutGuide`, and close
  only through the explicit accessory control or surface teardown. Reconcile metadata-only workspace
  snapshots without replacing the focused terminal DOM.
- D168. Keep the Control surface's full action row and local text echo while its keyboard is shown,
  but make keyboard, selected-surface, and video-layout state feed one relative-control visibility
  policy. Trackpad, scroll strip, display rail, and Spaces strip must stay hidden and noninteractive
  through settings and surface refreshes until the keyboard closes.
- R169. Add an explicit keyboard-time mouse control so video taps can target and click the Mac without
  dismissing the keyboard or restoring the relative trackpad and scroll-strip surfaces. Keep ordinary
  keyboard-time video taps dismissive until that interaction mode is deliberately enabled.
- D170. Stabilize the client simulator gate by serializing terminal keyboard tests that each own a key
  window and cold WebKit process, allowing bounded cold-start readiness under full-suite load, and
  sending runtime checkpoints through one ordered persistence-and-wire lane so suspended sends cannot
  overtake.
- D171. Prewarm the configured Whisper model after voice-server startup through the existing
  process-wide MLX executor (ADR-0082). Run one silent in-memory inference without blocking HTTP
  liveness, emit bounded import/inference/residency/memory timing, and make immediate real
  transcription queue behind the same owner.
- R172. Replace process-lifetime Whisper residency with a measured idle-eviction or on-demand reload
  policy only if host memory-pressure evidence shows the accepted prewarm footprint harms ordinary
  AgentDesk use. Preserve first-dictation latency as an explicit acceptance gate and do not trade it
  away for an unmeasured memory saving.
- D173. Prewarm the retained Kokoro reference-speech synthesizer after voice-server startup without
  blocking HTTP liveness (ADR-0083). Exercise the default direct-IPA voice under the retained
  synthesizer's serialization boundary, discard warmup audio, emit bounded timing, and prevent
  duplicate model loading when an immediate uncached request overlaps startup.
- R174. Replace process-lifetime Kokoro residency with a measured idle-eviction or on-demand reload
  policy only if the accepted reference-speech footprint harms ordinary AgentDesk use. Preserve
  first-playback latency as an explicit acceptance gate.
- D175. Separate reference-cache access from Kokoro model serialization so cached playback remains
  available during prewarm (ADR-0084). Bound generated artifacts at 256 MiB, maintain the cache at
  startup and after writes, reject oversized artifacts, remove orphan files, and lease active audio
  responses against concurrent eviction.

### D150 implementation checkpoint (2026-07-27)

- Added a dedicated Python reference-speech artifact store as the single pronunciation, synthesis,
  persistence, provenance, and cache boundary. The 82M Kokoro model, config, and 20 American-English
  voice packs are immutable-revision and SHA-256 pinned; `cd gesture-agent &&
  just download-kokoro-model` stages and verifies them, while ordinary playback downloads only the
  selected voice lazily.
- The host derives both displayed reference phones and synthesis IPA from the same CMUdict entry.
  Direct synthesis validates tokens against Kokoro's actual vocabulary and calls the model with the
  IPA plus voice pack, bypassing Kokoro's text G2P. Unknown CMUdict words and unsupported symbols are
  explicit errors. Long passages split only between words at Kokoro's 510-character limit.
- Generated 24 kHz mono PCM WAV and metadata pairs are atomic and retained under a configurable
  256 MiB LRU cache. Cache keys include all pronunciation and executor inputs; cached audio is
  rehashed before playback, so a missing, partial, or corrupt pair is regenerated rather than
  trusted. Startup and post-write maintenance remove incomplete or unmanaged files, and active
  responses lease their WAV against eviction until delivery finishes.
- The strict voice REST allowlist now includes reference state, artifact creation, and artifact audio.
  Mac uses direct loopback audio. iPhone reassembles ordered bounded chunks, writes a temporary WAV,
  verifies its SHA-256, plays it under a spoken-audio session, reports
  preparing/playing/completed/failed state to the shared UI, and cleans up on Stop or teardown. PCM
  never enters the input lane.
- Focused Python, web, InteractionPanel, host, generic iOS build, and full iOS simulator test gates
  pass. A real pinned-model smoke synthesized `/θˈɪŋk/` and `/θˈæŋk/` into 36,000 nonempty samples.
  `just check` passed 596 host tests and the Python/package/web/Rust gates; `just sim-test` passed 438
  client tests. Two `just check-all` attempts reached the full host suite but each hit a different
  unrelated timing failure, first two diagnostics-broker tests and then one agent-feed shutdown
  test. Both affected suites passed on immediate targeted retry, as did the final reference-audio
  client tests. No app was launched because manual runtime acceptance is the explicit R151
  checkpoint.

## v15 Phase 10: human-owned passages and retake history

### Position

The shared host-owned Voice library is recording-first today. One saved `transcript` is both
Whisper's observation and the text used to group heard phones, derive CMUdict reference phones, and
generate Kokoro speech. When Whisper stores `Hello. How would you?` for audio whose speaker intended
`Hello. How are you?`, the reference surface repeats the recognition error and gives the learner no
way to retain the original observation while correcting the exercise.

The user model is passage-first:

- A **practice passage** owns the human-approved **intended text**.
- An **attempt** owns one immutable recording, its original **machine transcript**, its raw observed
  phones, provenance, and transport audit.
- Reference phones and Kokoro speech derive from intended text. Transcript-guided heard-phone
  grouping derives from intended text plus the attempt's unchanged raw phone stream.
- A retake creates another attempt under the same passage. It never overwrites an earlier attempt.
- Recognition differences and phone evidence are observations, not proof of a pronunciation error
  or improvement.

This phase is the concrete shared-Voice execution plan for the attempt-history direction captured by
R134. It covers the host-authoritative InteractionPanel on Mac and iPhone. The separate native
on-device Passage experiment remains independent until a later decision explicitly converges or
retires it.

### Authoritative facts

| Fact | Owner | Mutation rule |
|---|---|---|
| Intended text | Practice passage, edited by the user | Versioned host update |
| Machine transcript | Attempt, written by Whisper | Immutable after finalization |
| Recording WAV | Attempt | Immutable until deletion |
| Raw observed phones and model provenance | Attempt analysis | Replaced only by explicit Reanalyze |
| Heard-phone word grouping | Derived from intended text plus raw phones | Recomputed after text edit or reanalysis |
| Reference phones | Derived from intended text plus pinned dictionary | Recomputed after text edit |
| Reference speech | Content-addressed Kokoro cache | Generated on demand from current intended text |
| Baseline selection | Practice passage | User-changeable attempt reference |

### Interaction direction

Use inline disclosure rather than a separate details route. The passage header stays visible and
owns intended-text editing, reference playback, attempt count, and **Record another take**. Expanding
it reveals attempt disclosures; the newest attempt opens by default and older attempts remain
collapsed. Each attempt shows the immutable machine transcript, a word-level machine-versus-intended
diff, learner/reference playback, and one word-oriented heard/reference phone comparison. Model,
dictionary, transport, and timing provenance remain under one secondary **Technical details**
disclosure.

The labels are **Intended text**, **Machine heard**, **Your recording**, and **Reference**. Do not use
**corrected transcript**, because the user owns intent while the audio and recognizer observation
remain evidence. A text difference says only that recognition differed.

### Rejected shortcuts and reopen triggers

| Option | Decision | Reason | Reopen trigger |
|---|---|---|---|
| Overwrite the saved machine transcript | Rejected | Destroys the original ASR observation and makes later diagnosis impossible | Never for retained evidence |
| Add editable intended text to otherwise unrelated recording cards | Rejected | Fixes one recording but leaves retakes fragmented and duplicates passage text | Only if retakes leave scope |
| Group recordings by normalized text | Rejected | Punctuation or a later edit can split one exercise or merge unrelated exercises | Never; use an opaque passage ID |
| Add a dedicated recording details page now | Deferred | Hides attempt context and adds navigation before the inline comparison is crowded | Reopen when time-aligned traces or calibrated scoring cannot fit one disclosure |
| Automatically claim improvement from transcript or phone differences | Rejected | Neither signal is calibrated pronunciation quality | Reopen only after R131/R133 acceptance |

### Ordered implementation plan

- R176. Lock the passage-attempt contract before UI work.
  - Write the technical decision for one host-owned practice-passage record with an opaque ID,
    intended text, edit revision, timestamps, and optional baseline attempt ID. Attempts retain their
    existing recording IDs and add one passage ID plus an immutable machine transcript.
  - Define a one-time atomic upgrade: every legacy recording becomes a one-attempt passage whose
    intended text and machine transcript both start from the legacy transcript. Replace the old
    read shape after migration; do not retain dual compatibility paths.
  - Record length, Unicode normalization, empty-text, missing-attempt, and revision-conflict
    invariants. An interrupted nonempty attempt is valid evidence; an empty capture is not.
  - Update the Python wire authority, generated TypeScript/Swift contracts where applicable, SPEC,
    and focused migration/round-trip tests.
  - Exit gate: legacy fixtures upgrade idempotently, intended text has one authoritative home, and
    `just check` passes.

- R177. Add bounded host persistence and mutation APIs.
  - Add cursor-bounded passage summaries and cursor-bounded attempt retrieval so attempt history does
    not turn the current all-recordings response into an unbounded payload.
  - Add exact passage read, intended-text update with `expectedRevision`, baseline selection, attempt
    deletion, and passage deletion. Return the authoritative updated revision after every mutation.
  - Extend recording-session start with an optional passage ID. The host validates it before capture
    and associates every completed or interrupted nonempty result with that passage.
  - Change reference-speech creation to resolve a passage ID plus its current revision rather than an
    attempt's machine transcript. Reject a stale revision so a word index from old intended text
    cannot synthesize a different word after an edit.
  - Keep REST and native voice-lane allowlists identical, reject stale or malformed requests loudly,
    and leave the existing single active-recorder invariant unchanged.
  - Exit gate: Python API, native-proxy, pagination, stale-write, migration, and deletion tests pass,
    followed by `just check`.

- R178. Make intended-text correction recompute only the facts that depend on text.
  - On edit, preserve the machine transcript, WAV hash, raw observed phones, analysis provenance, and
    transport audit byte-for-byte.
  - Rebuild CMUdict reference words and transcript-guided heard-phone grouping from the new intended
    text. Reanalysis still reads the immutable WAV and changes only raw phone analysis plus its
    derived grouping.
  - Fence displayed derivations by passage revision so a slow response for old text cannot replace a
    newer edit. Stop stale reference playback when text changes.
  - Let the existing content-addressed Kokoro identity generate audio for the new text without
    mutating or aliasing the old cache entry. Unknown dictionary words and synthesis failures remain
    visible per current behavior.
  - Exit gate: the `would` to `are` fixture changes reference phones, grouping anchors, and synthesized
    artifact identity while the attempt evidence hashes remain unchanged; focused Python/web tests
    and `just check` pass.

- R179. Replace the flat recordings list with the collapsible passage-and-attempt surface.
  - A collapsed passage shows intended text, attempt count, baseline/latest status, and last activity.
    Expanding lazily loads attempts. The newest attempt expands after capture; older attempts stay
    collapsed.
  - Put an explicit Edit action beside intended text. Edit mode has Save and Cancel, preserves the
    server revision it began from, disables reference playback, and presents a recoverable conflict
    when another Mac/iPhone surface saved first.
  - Each attempt shows **Machine heard**, an accessible word diff against **Intended text**, **Your
    recording** and **Reference** playback, completion/source badges, and error states.
  - Replace the distant heard/reference card stacks with word-oriented comparison rows. Keep the
    disclaimer that heard phones are sequence-aligned to intended words rather than acoustic word
    boundaries. Unknown and unassigned phones remain visible.
  - Use one outer passage disclosure, one disclosure per attempt, and one nested Technical details
    disclosure. Disclosure names, expanded state, focus return, diff meaning, playback controls, and
    errors must not depend on color alone.
  - Exit gate: component tests cover empty/loading/error/conflict/edit/cancel/unknown-word states,
    responsive Mac/iPhone layouts, keyboard and VoiceOver names, then `just check`.

- R180. Add the complete retake lifecycle.
  - **Record another take** enters capture with the passage's current intended text visibly pinned and
    the passage ID and revision captured at start. While that passage owns the active recorder, the
    host rejects intended-text edits from either surface so the target cannot change underneath the
    take.
  - Stop creates the next attempt under that passage and expands it after finalization. Cancellation
    before any accepted audio creates nothing. Disconnect or failure after nonempty audio retains one
    interrupted attempt with its transport audit.
  - **New passage** remains the free-form entry. Its first finalized attempt creates a draft passage
    with intended text seeded from the machine transcript and immediately asks the user to review the
    text. A missing transcript leaves an explicit empty intended-text editor rather than inventing
    words.
  - Reference or learner playback stops before capture. Capture, navigation, collapse, transport loss,
    and teardown retain the existing microphone and audio-session cleanup guarantees.
  - Exit gate: first take, repeated retake, empty cancel, interrupted retake, busy recorder, missing
    transcript, navigation, and teardown tests pass on loopback and native transports, followed by
    `just check`.

- R181. Add attempt history and honest A/B comparison.
  - Default the first completed attempt as the passage baseline while allowing the user to choose or
    clear another baseline. Interrupted attempts remain playable evidence but are never selected
    automatically.
  - Compare one selected attempt with the baseline through mutually exclusive A/B playback, machine
    transcript differences, and word-oriented heard/reference phone evidence. Keep timestamps,
    source, duration, model provenance, and interruption status visible.
  - Do not synchronize audio, normalize duration, calculate a score, rank attempts, color one as
    better, or claim improvement. Those behaviors remain blocked on the calibrated R131/R133 signals.
  - Paginate older attempts behind **Show earlier attempts** while keeping the passage and comparison
    selection stable.
  - Exit gate: baseline creation/change/clear, cross-page selection, interrupted-attempt handling,
    deletion fallout, and no-score copy tests pass, followed by `just check`.

- R182. Complete destructive, concurrent, and cross-device behavior.
  - Deleting one attempt atomically removes its WAV, attempt metadata, and attempt-owned derived
    results. If it was the baseline, clear the baseline visibly. Keep the empty passage so the user
    can retake or delete it explicitly.
  - Deleting a passage requires confirmation with its attempt count and removes all owned attempts.
    The bounded content-addressed Kokoro cache remains global rebuildable cache, not passage truth;
    the UI must not claim that passage deletion purges shared cached synthesis.
  - A successful mutation updates the initiating TanStack Query cache immediately and the other
    surface through the existing host-authoritative refresh path. Revision conflicts never silently
    overwrite text or baseline state.
  - Stop and release any learner/reference audio whose attempt or passage is deleted. Restore focus
    to the next stable passage header and provide accessible terminal success/error status.
  - Exit gate: atomic failure injection, concurrent Mac/iPhone edits, deletion during playback,
    baseline deletion, empty-passage retention, whole-passage deletion, and relaunch persistence tests
    pass, followed by `just check`.

- R183. Accept the complete loop on the real shared surfaces.
  - Run the full package, Python, web, host, Rust, and client gates and re-read the complete diff for
    contract, naming, revision, lifecycle, cache, deletion, and documentation agreement.
  - Stop at the device checkpoint. After explicit approval, launch current-sha Release builds and
    verify the same host library from Mac and physical iPhone.
  - Acceptance script: use the retained `Hello. How would you?` recording when available, otherwise
    seed the same deterministic mismatch fixture; edit intended text to `Hello. How are you?`; verify
    the original machine transcript remains; verify the reference word and passage phones use `are`;
    verify Kokoro says `are`; replay the unchanged learner WAV; make at least two live retakes under
    that intended text; select a baseline; compare attempts; edit from the second surface to exercise
    a revision conflict; delete one attempt; relaunch both surfaces; then delete the passage.
  - Preserve host unified logs and attached iPhone logs for the same run, verify exact build SHA on
    both surfaces, and record any unaccepted behavior without promoting the task.
  - Exit gate: all automated gates and the complete physical script pass; promote R176-R183 and the
    R134 attempt-history objective with their code, tests, ADR/SPEC updates, and ledger transitions in
    the same landed commits.

### Dependency and landing order

```text
R176 contract and migration
  -> R177 persistence and APIs
  -> R178 correction derivations
  -> R179 collapsible passage UI
  -> R180 retake lifecycle
  -> R181 baseline and A/B history
  -> R182 deletion and concurrency hardening
  -> R183 automated and physical acceptance
```

Each task is one coherent landing arc and runs `just check` before its R-to-D transition. Contract
work lands before consumers; no feature flag or parallel legacy path is planned. If one task cannot
meet its exit gate, revert that task's commit while leaving the last green contract-compatible task
landed.

### Implementation checkpoint

R176-R182 are implemented across Python persistence and APIs, generated web wire types, the shared
InteractionPanel, the native Voice REST allowlist, and keyboard-dictation result decoding. Focused
verification passes: 51 Python passage/reference/HTTP tests, 32 web tests including the interactive
passage surface, TypeScript, focused ESLint, the production embedded bundle, and five
VoiceLaneServer tests. The repository-wide `just check` passes, including 630 Swift tests plus the
package, Python, web, Rust, host, and client build gates. R183 remains the explicit real-surface
checkpoint; no host or device app has been launched.

## v15 Phase 11: typed references before recording

### Position

A practice target must exist before the learner records it. **Add reference** creates a real
zero-attempt passage from typed intended text. Saving text performs no capture or model inference.
The learner can expand the passage, inspect revision-fenced dictionary phones, and ask Kokoro to
speak it before choosing **Record first attempt**. The first later capture attaches to that passage;
it never creates a duplicate or fake silent attempt.

Speech-first **New passage** remains a secondary entry path for now. Reference phones stay derived
from intended text, and synthesized WAVs stay in the bounded rebuildable cache.

### Ordered implementation plan

- **R189** Extend ADR-0085 and SPEC with typed creation, zero-attempt state, lazy pronunciation, and
  the explicit no-recording/no-inference invariant.
- **R190** Add atomic `PracticePassageStore.create_passage`, `POST /practice-passages`, and a
  revision-fenced lazy reference-pronunciation read model. Preserve normalization, limits, unknown
  words, duplicate text, and restart persistence.
- **R191** Add generated wire types and narrowly allowlist root passage POST plus validated
  `GET /practice-passages/{id}/reference?revision=N` through the native Voice lane.
- **R192** Add the shared **Add reference** dialog, zero-attempt disclosure, independent
  reference-phone loading, word and passage playback, focus/status recovery, and first-practice
  handoff.
- **R193** Refine recorder language and cover Python, native, API, React, accessibility,
  stale-revision, failure-retention, and no-recording behavior. Run the complete automated gate and
  self-review.
- **R194** Stop at the device checkpoint. After explicit approval, create and hear a typed reference
  on current-sha Mac/iPhone surfaces, record attempt 1, verify baseline attachment and relaunch
  persistence, edit to exercise stale-reference rejection, then preserve both log streams.

### Dependency and landing order

```text
R189 contract
  -> R190 persistence and pronunciation
  -> R191 wire and native proxy
  -> R192 shared UI
  -> R193 automated acceptance
  -> R194 authorized physical acceptance
```

### Implementation checkpoint

R189-R193 are implemented across atomic zero-attempt passage persistence, the revision-fenced
reference-pronunciation read model, generated wire types, the native Voice REST allowlist, and the
shared InteractionPanel. Typed creation stores passage metadata only; it creates no recording JSON
or WAV and invokes no capture or synthesis path. Focused verification passes: 73 Python voice tests,
35 web tests, TypeScript, focused ESLint, and the production embedded bundle. The repository-wide
`just check` passes, including 666 Swift tests plus the package, Python, web, Rust, host, and client
build gates. R194 remains the explicit real-surface checkpoint; no host or device app has been
launched.

## v15 Phase 12: explicit microphone choice and recorder reset

### Position

The shared browser recorder previously always opened the browser's default input, and Reset existed
only after completion or failure. A learner switching between the Mac microphone, a headset, and an
external interface needs an explicit device-local choice before capture. Reset must also be a stable
way back to free-form **New passage** without deleting the selected practice passage from the
host-owned library.

### Implementation checkpoint

- **D195** Persist one browser microphone selection, enumerate and refresh available `audioinput`
  devices, and apply an explicit selection as an exact `getUserMedia` device constraint through the
  shared capture hook. Keep system default as an explicit fallback and surface an unavailable saved
  device instead of silently recording from another input.
- **D196** Keep Reset visible on the recorder outside active finalization and make it clear both the
  ephemeral voice run and the selected passage target. Reset does not call a passage deletion API;
  durable passages and attempts remain library truth.
- **D204** Remove the passive bordered New passage explainer so controls lead in free-recording
  mode. Keep actual practice and retake intended text as compact inline context, without removing
  Record, Stop, Reset, microphone selection, status, input level, transcript, or preamp actions.
- **D205** Make the interaction panel's media-capture callback a current-SDK `WKUIDelegate`
  witness. Grant camera and microphone capture only to the bundled `interactionfeed://app` origin,
  deny every other origin or future capture type, and log each decision so a host restart reuses the
  macOS grant instead of falling through to WebKit's process-scoped prompt.
- Focused selection, constraints, and recorder tests pass. Repository-wide acceptance passes; a
  real microphone-switch and restart run remains the gate before claiming the physical inputs or
  persistent permission behavior were exercised.

## v16 Phase 1: stall recovery on a manually pinned stream

### Position

Four device sessions on 2026-07-30 measured the failure: two clean, two freezing for 42.1s and
44.2s in stalls of 1.5-12.8s. All four ran with the phone's adaptive quality switch OFF. A fifth
session, adaptive ON, on the same link minutes after the worst manual one, froze once for 1.6s.

### Authoritative facts

- Not bandwidth. Across all 1,882 quality windows that day the client reported three lost frames
  and three resend requests, none during a stall.
- Not the pinned numbers. The client's manual floor (180kbps / 1fps / 33%) is below the adaptive
  ladder's own emergency rung, so no reachable preset would have helped.
- The stall shape is the client going silent (`ackCount=0`, no link-health reports) while the host
  keeps producing, then reporting a burst of completed frames — 49 in one 0.5s window after the
  12.79s stall. The frames arrived; the client processed them late.
- Three recovery mechanisms were reachable only through a rung change, which a pinned target never
  makes. See ADR-0087 for the decision and the bandwidth arithmetic behind each constant.

### Ordered implementation plan

- **R184** Derive pressure signals in both quality modes. `MediaQualityController.makeSignals`
  becomes internal and the manual branch of `observeLinkHealth` calls it instead of hand-building a
  struct with four of six classes hardcoded `false`. Target stays unmoved. Prerequisite for R185,
  which triggers on these signals.
- **R185** Flush and force a keyframe on a stalled window, in both modes.
  `QuicSessionHostMediaState.recoverFromStall` returns a `MediaStallRecovery`, applied by
  `applyQualityDecision` before its `outcome.changed` gate. The flush runs on every stalled window;
  the keyframe is spaced by `ownedMediaStallRecoveryMinIntervalMs` and suppressed while one is in
  flight. Reverses an ADR-0033 decision driver, recorded in ADR-0087.
- **R186** Bound the GOP in wall clock. `ownedMediaKeyframeMaxIntervalMs` (15s) alongside the
  existing 120-frame interval; whichever comes first wins, so 15fps+ is unaffected. Fixes the
  two-minute worst case at ADR-0073's own 1fps validation profile.
- **R187** Raise a quality window on the host's clock after `ownedMediaLinkHealthTickMs` of client
  silence. Synthetic windows carry `clientReportMissing` and earn no recovery credit, so a silent
  client is never read as a calm screen. Lands last: it changes when R184-R186 fire.

### Dependency and landing order

R184 before R185. R186 is independent. R187 last, and it is what makes R185 reach an in-progress
freeze rather than only the window after one — during the measured 12.79s stall not one window was
evaluated.

### Implementation checkpoint

R184-R187 are implemented across `MediaQualityController`, `MediaTransport`,
`OwnedMediaTransport`, `VideoToolboxOwnedMediaEncoder`, and `Config`, with ADR-0087 recording the
decision. `MediaStallRecoveryTests` adds 12 tests covering both halves of recovery, the rate limit,
the GOP ceiling at 1fps, and the synthetic-window credit rule. Repository-wide `just check` passes
with 666 Swift tests in 87 suites. R188 remains the real-surface checkpoint: none of this has been
judged on a device, and the felt claim — that a manual pin stops freezing — is only measurable
against the 42.1s-frozen baseline in a device session.

## v16 Phase 2: hand the periodic GOP to the encoder

### Position

R186 hand-rolled a wall-clock keyframe ceiling beside a frame counter. VideoToolbox has had
both, with identical "whichever comes first" semantics, since macOS 10.8 —
`kVTCompressionPropertyKey_MaxKeyFrameInterval` and `...MaxKeyFrameIntervalDuration`, the
latter documented as being for exactly our case, a variable frame rate. We set neither.

Our version also has a real bug the platform's does not: `frameId.isMultiple(of: 120)` is an
absolute modulo on a counter that never resets, so a keyframe emitted for any other reason
(client request, stall recovery, resolution change) does not restart the interval. Apple's is
defined as the maximum interval *between* keyframes.

### Ordered implementation plan

- **R189** Prove this Mac's hardware HEVC encoder honors both properties at our exact session
  settings, including `EnableLowLatencyRateControl`. A gate, not a nicety: `setProperty`
  tolerates `kVTPropertyNotSupportedErr` and both keys are documented Optional, so a declined
  property is invisible at the call site and would leave the stream with no ceiling at all.
  Green means R190-R192 are viable; red means abandon this phase and fix the modulo in place.
- **R190** Set both properties in `ensureSession`; delete `isPeriodicKeyframe`,
  `lastKeyframeUptimeNs`, and the periodic term in `encode`. `forceKeyframe` reduces to
  `requestedKeyframe || encodedFrameId == 1`. Config knobs keep their names and defaults and
  become property values. This is what fixes the modulo bug.
- **R191** Rework the keyframe diagnostics: `expected=` becomes meaningless once the platform
  places periodic keyframes, so replace it with `source=requested|encoder`. Delete the dead
  `allowPeriodicKeyframe` parameter and collapse `resolveKeyframeReason`, whose last two
  branches already both return `.periodic`.
- **R193** Thread the real cause of each forced keyframe through `EncodeState` instead of
  labelling all five as `client-request`. Found in R191's self-review: R185 added stall
  recovery as a fifth source, and being observable is the entire point of it.
- **R192** Rewrite the placement tests to assert the contract rather than exact frame
  positions. `testPeriodicKeyframeFiresAtInterval` asserts frame 3 is not a keyframe at
  interval 2, which the platform's "at least every other frame" semantics likely inverts.

### Implementation checkpoint

R189-R192 landed 2026-07-31. R189 confirmed both keys are advertised, accepted, and read
back at our exact session settings. R190 set both as session properties through a strict
setter that rejects the session rather than tolerating an unsupported one, and deleted
`isPeriodicKeyframe`, `lastKeyframeUptimeNs`, and the periodic term in `encode`. R191
replaced the `expected` keyframe flag with `source=requested|encoder`, deleted the dead
`allowPeriodicKeyframe` parameter, and collapsed `resolveKeyframeReason`. R192 replaced four
tests of the deleted pure function with two behavioral ones asserting the interval as a
bound, both confirmed to discriminate by asserting a wrong value first. R193 followed from
R191's self-review: `forceKeyframe: Bool` became `forceKeyframeReason`, so a stall recovery
no longer logs as a client request. Wire values are unchanged and tested to stay that way --
every forced reason still classifies as `.reset`, exactly as the collapsed `clientRequest`
did.

The sparse-frame test established that VideoToolbox measures the duration ceiling against
the presentation timeline rather than the host clock, so ADR-0073's 1fps profile is provable
in milliseconds. Repository-wide `just check` passes with 662 Swift tests in 87 suites (four
fewer than before, being the removed tests of the deleted function). R188 is still the open
device checkpoint for the whole phase.

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
R137  implemented remaining  physical normal-cycle and killed-analysis host-bundle proof
D138  2026-07-26  landed     persistent passage library and bundled-sample raw-audio reanalysis
D139  2026-07-26  landed     inline transcript-word phone grouping with raw evidence preserved
R140  implemented remaining  manual model-selector and comparative saved-audio acceptance
D141  2026-07-27  landed     host-authoritative voice persistence, Whisper, and ZIPA finalization
D142  2026-07-27  landed     authenticated bounded QUIC voice lane and loopback proxy
D143  2026-07-27  landed     native iOS InteractionPanel voice transport
D144  2026-07-27  landed     shared host voice library and explicit finalization states
R145  implemented remaining  authorized cross-device runtime acceptance
D146  2026-07-27  landed     shared Voice transcript and word-grouped heard/reference Passage cards
D147  2026-07-27  landed     one continuous shared Voice scroll surface
D148  2026-07-27  landed     local whole-passage and per-word reference TTS
D149  2026-07-27  landed     retired split native reference TTS authority
D150  2026-07-27  landed     host Kokoro direct-IPA artifacts and cross-device playback
R151  implemented remaining  authorized Mac/iPhone reference playback acceptance
D152  2026-07-27  landed     web-owned macOS dictation mini and retired Swift audio pipeline
D153  2026-07-27  landed     reviewed iPhone dictation sheet via remote keyboard input
D154  2026-07-27  landed     optional iPhone dictation recording prefix
D155  2026-07-28  landed     physical keyboard handoff and App Group return-path spike
D156  2026-07-28  landed     production host-owned systemwide keyboard dictation
R157  implemented remaining  physical production keyboard dictation acceptance
D158  2026-07-28  landed     fixed native-adjacent keyboard geometry and feedback
R159  implemented remaining  physical keyboard appearance and interaction acceptance
D160  2026-07-28  landed     bounded UIKit Character Preview for ordinary keys
R161  implemented remaining  physical Character Preview acceptance
D162  2026-07-28  landed     return glyph with semantic action labels and accessibility
D163  2026-07-28  landed     native home-row alignment, outer-key gutters, and blank Space
D164  2026-07-28  landed     nonblocking in-app keyboard dictation activation and status
D165  2026-07-28  landed     stable long final transcription and initialism passage playback
D166  2026-07-28  landed     loss-detecting Voice capture and durable transport continuity audit
D167  2026-07-28  landed     durable standalone terminal keyboard focus and accessory controls
D168  2026-07-29  landed     keyboard-authoritative relative Control chrome
R169  candidate   remaining  explicit keyboard-time video mouse control
D170  2026-07-29  landed     deterministic terminal tests and ordered runtime checkpoints
D171  2026-07-29  landed     startup Whisper prewarm through the single MLX executor
R172  captured    remaining  measured idle eviction or on-demand reload if memory pressure warrants
D173  2026-07-29  landed     startup Kokoro prewarm through the retained reference-speech store
R174  captured    remaining  measured Kokoro idle eviction or on-demand reload if warranted
D175  2026-07-29  landed     independent cache access and bounded reference-speech maintenance
D176  2026-07-30  landed     host-owned practice-passage contract and deterministic migration
D177  2026-07-30  landed     bounded revision-fenced passage persistence and APIs
D178  2026-07-30  landed     intended-text-derived phone grouping and reference speech
D179  2026-07-30  landed     collapsible shared passage and attempt library
D180  2026-07-30  landed     revision-pinned retake and new-passage lifecycle
D181  2026-07-30  landed     baseline selection and honest paginated A/B evidence
D182  2026-07-30  landed     atomic deletion and cross-surface conflict handling
R183  checkpoint  remaining  complete shared-surface runtime acceptance
D184  2026-07-30  landed     honest pressure signals in both quality modes
D185  2026-07-30  landed     stall flush and rate-limited recovery keyframe, ladder-independent
D186  2026-07-30  landed     wall-clock ceiling on the video GOP
D187  2026-07-30  landed     host-raised quality window when the client goes silent
R188  checkpoint  remaining  authorized device acceptance against the 42.1s-frozen baseline
D189  2026-07-31  landed     proved the encoder honors both keyframe-interval properties
D190  2026-07-31  landed     handed periodic keyframe placement to the encoder
D191  2026-07-31  landed     keyframe diagnostics that survive platform-placed keyframes
D192  2026-07-31  landed     placement tests asserting the contract, not frame positions
D193  2026-07-31  landed     honest cause on every forced keyframe, not a blanket client-request
D189  2026-07-30  landed     typed-reference contract refinement
D190  2026-07-30  landed     atomic zero-attempt creation and reference derivation
D191  2026-07-30  landed     typed-reference wire and native proxy
D192  2026-07-30  landed     shared typed-reference and first-practice UI
D193  2026-07-30  landed     automated typed-reference acceptance
R194  checkpoint  remaining  typed-reference Mac/iPhone runtime acceptance
D195  2026-07-31  landed     persisted browser microphone selection at the shared capture seam
D196  2026-07-31  landed     stable recorder reset that clears the next-passage target
D197  2026-07-31  landed     measured which link metrics the platform actually gives us
D198  2026-07-31  landed     link telemetry on the existing link-health message
D199  2026-07-31  landed     client path, radio, and receive-loop observers
D200  2026-07-31  landed     unconditional link-health report carrying telemetry
D201  2026-07-31  landed     host path observer and round-trip inflation on one correlated line
D202  2026-07-31  landed     recovery credit judged on what a report says, not who sent it
D203  2026-07-31  landed     authorized cellular device acceptance with telemetry live
D204  2026-07-31  landed     quiet free-recording state with compact practice context
D205  2026-07-31  landed     persistent host microphone consent through a real WebKit delegate witness
D206  2026-07-31  landed     stall detection that compares client silence against the host's own quiet time
D207  2026-07-31  landed     link-change detection across interface, address, path, and radio (ADR-0089)
D208  2026-07-31  landed     authorized handover device run: found the report cannot survive the event it reports
D209  2026-07-31  landed     cumulative link counters, so a dropped report costs latency and not evidence
D210  2026-07-31  landed     control sends that fail say so, edge-triggered rather than per message
D211  2026-07-31  landed     probe-then-resume: a link change arms recovery, unanswered silence fires it
D212  2026-07-31  landed     authorized handover device run: recovery fires, and a silent death still wedges the client
D213  2026-07-31  landed     a way out of a session the client thinks is alive and the host has ended
D214  2026-07-31  landed     liveness echo: recover from a dead path with no link change, sized against the 12.4s healthy-gap ceiling
D215  2026-07-31  landed     retain the video sink across a transport swap, so a switch keeps the last frame instead of going black
X216  2026-07-31  dropped    measure display-layer reference retention: not measurable before ADR-0090 exists, and not needed

D215 detail: the only thing blacking the screen on a switch was `videoSink = nil` in
`teardownMediaTransport`. Everything else was already in place -- `attachMediaTransport` adopts
an existing sink rather than building one, `render`'s preserved-surfaces branch keeps the host
view up, and `hideTrackpad` removes only control chrome. The reuse path was written and simply
unreachable. Recovery teardown now keeps the sink (and with it the decoder, which is what
ADR-0090 needs), shows "Reconnecting…" over the frozen frame so it does not read as a hang, and
carries the Reconnect button along in case the redial never lands. A full teardown -- user
disconnect, unpair, rejection -- still removes everything as before.
D217  2026-07-31  landed     LTR recovery: a resync costs the delta since an acknowledged frame, not a keyframe
R218  checkpoint  remaining  device run: confirm a resync frame is hundreds of bytes, not hundreds of KB, with no corruption
D219  2026-07-31  landed     keep the host encoder alive across a reconnect, so LTR also covers the handover case
D220  2026-07-31  landed     open the resume window: count the deadline from the drop, and stop a dead connection ending the session
```

D220 detail: the TTL retune this arc kept deferring was the wrong question. `sessionResumeTTL`
was never why resume failed. `resumeExpiresAt` was stamped once at the handshake as
`establishedAt + 20s` and never moved, so any session older than twenty seconds carried a
deadline already in the past -- both sides refused before trying. The deadline is now derived
from `suspendedAt` (or now, for a session the host still believes is live), which is what the
field always meant; the client keeps no expiry at all, because only the host can compute one.

The second bug made the first academic. A QUIC connection reaching `.failed` or `.cancelled`
ended the session outright, which D212 measured firing 9.6s into a handover with ten seconds
still on the window. Under ADR-0030 the session outlives the connection, so a lost connection is
a suspend; only a connection that never established one still ends anything. A superseded
connection's close is now ignored, since after this change it would otherwise suspend the live
session the client already moved.

Neither fix does anything alone, which is why they land together. Still open: a session the host
wrongly believes is connected holds its window open forever, because it reads "connected" as "in
contact" -- D214's echo is what closes that.
D221  2026-07-31  landed     release the session's encoder when the session ends, and key it by session so a fresh decoder never inherits one
D222  2026-07-31  landed     authorized device run: resume works (240ms, encoder reused), and a failed dial was eating the window
D223  2026-07-31  landed     a failed dial clears only the attempt, so it stops ending the suspended session beside it
D224  2026-07-31  landed     LTR eligibility by exclusion, and a client that flushed its decoder can say so
D225  2026-07-31  landed     second device run: LTR is enabled, fires, and degrades to an IDR every time
D226  2026-07-31  landed     make the LTR round trip observable, and stop two different counters both logging as `frame=`
D227  2026-08-01  landed     LTR works; a session recreate is what wipes it, so drop its state with the session
D228  2026-08-01  landed     carry the ladder rung across a resume, so recovery stops rescaling itself out of the cheap path
D229  2026-08-01  landed     device run: the cheap recovery frame lands at 529 bytes; the rescale after it is the new cost
R230  2026-08-01  open       the client display layer can wedge black, survive every reconnect, and read as healthy
R231  2026-08-01  open       decouple resolution from the rung, so congestion is answered by the two free axes first

D214 detail: a control-message pair (`liveness-probe` / `liveness-echo`) carrying a sequence
number on the existing `frameId` field. Three unanswered probes at 2s declares ~4.5s after the
last arrival, against the 9.6s the transport took to notice the same death, and inside the resume
window so it resumes rather than re-pairs. No echo-to-probe matching: the receive loop counts
every datagram before dispatch, so an echo is already an arrival and any arrival proves the same
thing -- which is also why an active session never probes at all. The echo bypasses the send
pacer, since queueing it behind undeliverable video would make it exactly as slow as the thing it
measures. It stays quiet until the session has carried one datagram, because otherwise a
slow-starting session gets declared dead ~6s into its own startup by probes the host is not yet
reading.

D221 detail: keying the encoder by device (D219) was wrong on a path development never
exercises -- the app restarting. Resume material is in-memory only, so a restarted app always
dials fresh and builds an empty decoder, while a device-keyed encoder would hand it the previous
session's reference state. The encoder's frame counter persists too, so nothing forces a true
keyframe: the client cannot decode the delta, requests a keyframe, and that request routes back
through `requestLtrRefresh` into another delta against the same unreachable reference. A
livelock, presenting as "black screen after restart". Keying by session id makes the encoder's
lifetime the client decoder's lifetime, and releasing on session end is then also the idle
release -- a paired device that is not connected holds no compression session.

## Handover arc (ADR-0089)

The cellular acceptance (D203) reproduced the freeze and reframed it. It is not congestion and
not a tailnet fault: a WiFi-to-cellular switch black-holed traffic for 18 seconds while the host
sent 622 frames into it, and the QUIC connection reported nothing until the very end. Steady
cellular is healthy -- 611 windows under load with no client gap exceeding the host's own quiet
time, and 54 tailnet pings all direct with no relay fallback. The trigger is the phone's address
changing, whether from an interface switch or a 5G-to-3G radio transition.

ADR-0030 already built the machinery to survive this, and its confirmation criterion
(`suspended -> resuming -> connected`) has never been met because nothing could detect the
switch: there was no `NWPathMonitor` anywhere in the tree before D198. Resume is wired to
`willEnterForeground`, which cannot fire during a network change because the app never leaves
the foreground.

D207 ships detection only, deliberately. R208 measures which cause fires first; Phase 2
(probe-then-resume), Phase 3 (host-side liveness suspend), and the `sessionResumeTTL` retune
are all gated on that number, because the 20s TTL against 18s detection is why resume expires
almost exactly when it becomes possible.

D208 ran that measurement and found the instrument broken in a way only a device could show. A
real WiFi-to-cellular switch produced `linkChanges=0` in all 976 delivered reports, because the
report is a datagram sent over the link it describes and the counters were drained before the
send. Loss ran 0.2% at rest and 18% inside the freeze: the link change is what makes the report
carrying it go missing, so a delta counter is destroyed exactly when it finally matters. D209
makes all three counters cumulative and the causes sticky, so a dropped report costs latency
rather than evidence.

The measurement survived anyway, pulled from the client's own on-device store via
`just client-diagnostics` (no WiFi, no sudo). One record in 1845 carried it:
`linkChanges=2 linkCauses=interfaceType(wifi->cellular),localAddress(b2216da5->3c873047)` at
18:34:05, against a freeze that began at 18:34:04.4 and self-recovered at 18:34:13.4.
**Detection fired within one report window; the transport never fired at all** -- the only
`Network is down` in the host log is session startup. So a recovery path waiting on transport
failure can wait forever, and `sessionResumeTTL = 20s` is not the binding constraint against
~0.5s detection. Both live causes fired together, which validates the address digest on real
hardware.

D211 acts on it. A link change arms recovery and sends a keyframe request; unanswered silence
past a 2s grace declares the session dead and re-dials. Both conditions are load-bearing:
firing on the change alone would tear down healthy sessions on transparent tailnet route
switches, and firing on silence alone would reconnect a merely idle session -- the calm-screen
false positive from `ef649c86`, worse here because acting on it drops a live session. The
keyframe request is the probe that tells those apart. D210 makes a control send that never
leaves the device say so, which is how the probe's own failure becomes visible.

The re-dial is half of D211, not a follow-up: `handleMediaSessionFailed` parks the client in
`.pairedDisconnected` and nothing moved it out except foreground or a manual tap, so declaring
death faster without dialing would have replaced a nine-second freeze with a disconnect screen.
This also closes the original gap -- ADR-0030's resume machinery could never run during a
handover because the app never leaves the foreground.

D212 ran that confirmation. The cumulative-counter fix is proven: the host received
`linkChanges=2 linkCauses=interfaceType(wifi->cellular),localAddress(...)` where the previous
run reported zero in all 976 windows. Recovery armed and tore down ~2s after the change, as
designed.

It also found two things the design did not cover. The black still lasted ~11s, and **9.5s of
that was the phone's cellular path not being usable yet** -- detection was never the bottleneck
for that switch, the radio was. And for a freeze that would have self-healed (the earlier 3G
case, back in 9s with state intact), tearing down at 2s and re-dialing is a net loss: same radio
delay plus a handshake plus a new session.

Then the real failure, twice: the connection timed out with the link completely stable. The host
ended the session, the client never noticed, stayed `.connected`, and showed "Mac display
unavailable" over a dead session. `triggerSessionIfPaired` no-ops unless the state is
`.pairedDisconnected`, so nothing retried and **force-quitting the app was the only way out** --
the ADR-0030 symptom this arc exists to remove, reached by another route. Phase 2 cannot catch
it: recovery is gated on a link change and the link never moved.

D213 adds the Reconnect button as a backstop, and stops the label claiming "Input stays
connected" when nothing is. R214 is the actual fix: drive recovery from an unanswered liveness
echo rather than from a link change, so a dead path is caught whatever killed it. Two measured
constraints on it -- the carrier keepalive is client-to-host only, so healthy idle windows
showed arrival gaps up to **12.4s** (any shorter silence rule false-positives), and keyframes
ran ~244KB, so the Phase 2 keyframe probe is far too expensive to use as a poll. Hence a small
echo rather than a reused keyframe request.

Two side findings from D208 worth keeping. The host's degradation machinery works -- `freeze`,
`stall-recovery`, `no-ack-at-cap`, and a drop to rung 3, with the `ef649c86` stall fix running
live and not producing its old calm-screen false positive. And this freeze was one-directional:
67 of 82 client reports still arrived while `datagramsReceived` stayed 0, so the uplink survived
and Phase 2 can plausibly signal over it.

D222 detail: the first device run where resume could happen at all. `session suspended` ->
`session resuming` -> `session ready` in 240ms on the same session id, with `reusing media
encoder`, which is ADR-0030's confirmation criterion met for the first time since it was
written. It also caught two things the gate could not.

A failed dial was ending the session beside it. `notifyConnectionLost`'s never-established
branch called the session-ended handler with a nil session id, and ending by fingerprint removes
whatever record exists -- so during a handover, where the client re-dials immediately and the
first dials fail while the radio switches, each failure destroyed the resumable session a
different connection had just suspended, about 40ms after it was suspended (D223).

And the screen still went black, because the first frame after the resume was a 171KB keyframe:
only two of the five paths that force a keyframe had opted into the long-term-reference path,
and resume was not one of them (D224).

D224 detail: eligibility is now an exclusion list in the encoder rather than an opt-in at each
call site, so a new resync path gets the cheap path by default instead of silently missing it.
That exposed a livelock the opt-in had been hiding: VideoToolbox cannot un-acknowledge a
long-term reference, but the client discards its decoder on several recovery paths -- render
stall, wedged layer, dimension mismatch -- each clearing the format description and flushing the
layer. Those paths ask for a keyframe and would now get a delta against references they just
dropped, fail to decode it, and ask again. The render-stall path had exactly that shape,
`requestKeyframe()` immediately followed by `videoDecoder.reset()`. The keyframe request now
carries `clientHasNoReferences`, since the client is the only party that can know.

D225 detail: the run that was supposed to confirm ADR-0090 disconfirmed it. Resume itself worked
on hardware -- same session id, encoder reused, its counter continuing 690 to 703 across the
drop -- and the refresh fired on the resume exactly as D224 intended. VideoToolbox answered with
a 185 KB IDR. `EnableLTR` had succeeded, so by the encoder's contract that means no long-term
reference had ever been acknowledged, and the "degrades to today's behaviour" fallback was not a
worst case but the only case. Which half of the round trip is broken is still unknown, because
nothing logged tokens at all: the request was the mechanism's only observable, so working and
not working printed the same thing. Two secondary findings. The switch was made from Settings,
which backgrounded the client for 3m21s and blew past the 20s resume TTL, so what the run
measured was a cold start rather than a handover -- a real handover test must keep the app
foregrounded. And the ladder did climb back this time, contradicting the previous run's "never
climbs"; what it does instead is oscillate between rungs 1 and 2, with `resolution-change`
causing 23 of 25 forced keyframes, which the exclusion list denies the cheap path by design.

D226 detail: four log points, one per stage of the round trip, so the next run names the broken
half instead of leaving it to inference: `ltr-token-emitted` (the encoder nominated a
referenceable frame), `mediaLtrAcknowledged` client-side (it reached the sink and an ack went
out), `ltr-ack-received` (the control message survived the wire), and `ltr-refresh-result` with
an explicit `outcome=idr-fallback`. The refresh request carries the cumulative emitted and
acknowledged counts, which is the decisive pair: zero emitted is an encoder producing no
references, emitted-without-acknowledged is a client or wire fault. Also renamed the encoder's
lifetime counter to `encFrame`. It and the wire's `frameId` were both logging as `frame=` while
meaning different things, and once D219 made the encoder outlive the transport the two started
diverging by design -- a `frame=1` after a resume read as a rebuilt encoder and briefly looked
like the whole mechanism had failed, when it had carried across correctly.

D227 detail: the telemetry answered in the first minute, and reversed D225's reading. 237 tokens
emitted, 237 acknowledged, every frame nominated as referenceable, and a client keyframe request
answered with a 2,221-byte delta where keyframes in the same session cost ~88KB. The round trip
was never broken. What wipes it is `ensureSession`: a resolution change invalidates the
compression session, and every long-term reference lives inside that session. The ladder resets
to full scale when a reconnect builds a new transport, so the resume ran at scale 1.0 straight
after suspending at 0.5 -- recreating the session inside the same encode call that then asked
for a refresh. Three pieces of state now reset with the session: queued acknowledgements, which
would otherwise be handed to a session that never issued those tokens, and both counters, which
would otherwise report references the new session does not hold -- the exact number the refresh
telemetry is read for, so leaving them would have made the instrument lie in the one case it
exists for. Consequence for planning: pinning the ladder rung across a resume is not a
refinement of ADR-0090, it is the precondition for the cheap path firing on a handover at all.

D228 detail: the rung now rides in the same session-keyed entry as the encoder, so it survives a
transport swap and a resume opens where the previous connection left off instead of at the
ceiling. One entry and one lifetime rather than two parallel dictionaries, because the two are
not independent: the encoder's references are only valid at the resolution that produced them,
and keeping the encoder while resetting the ladder is exactly what broke it -- the reset
rescaled, the rescale recreated the compression session, the references died inside it. Only the
target carries; backpressure, the resend ring and the round-trip samples all describe the
connection that just died and would be actively wrong applied to the new one. The rung is an
opening bid, not a freeze: `pin` clears the recovery credit so the ladder re-earns its climb,
since the link may genuinely have changed and that is usually why the drop happened. Tests pin
both directions -- a first connection still opens at the ceiling, a resumed one does not, and
the scale assertion is separate because it is the one that decides whether `ensureSession`
recreates.

D229 detail: authorized device run on a foregrounded Control-Centre WiFi toggle, which is what
finally exercised a real handover rather than a cold start. Both resumes recovered with a delta:
`outcome=ltr-delta bytes=529` and `bytes=1048`, against the 185KB the same path cost before
D228. The rung carry is what made the second one work -- it opened at the scale it left off at,
so nothing recreated the session before the refresh. ADR-0090 is confirmed end to end.

The screen was still black for about fifteen seconds, and the cause has moved. Both recoveries
were followed within a second by `ltr-state-dropped reason=session-recreate` and a full keyframe:
90KB, then 74KB, then 175KB. The carried rung is honest about the link it was measured on, and a
handover is exactly the event that changes that link -- a rung earned on WiFi is over-provisioned
for cellular, so the first observation window rescales, and a rescale costs a true keyframe by
construction. That is correct adaptation, not a bug, which is why the fix is not to suppress it.
`ltr-state-dropped` fired 25 times in eight minutes, so it is not handover-specific either: the
ladder oscillates in steady state and every oscillation resets the reference set. Two disconnect
cycles 8s apart also mean the radio transition itself is still a large part of the fifteen
seconds. Next lever is rescaling less often, since making a rescale cheap is likely impossible --
the reference invalidation at a new resolution is real.

R230 detail: found on the D229 device run and confirmed by the operator. After the WiFi-to-
cellular toggle the phone showed black and stayed black for minutes. Both resumes had already
succeeded, the host was streaming, and the client reported presenting at 23-26 fps with
`renderStallCount=0`, `decodeDropCount=0`, `droppedFrames=0`, `presentationGapCount=5`. A force
quit and relaunch cleared it immediately, and repeating the same network switches after the
restart worked. So transport, host capture and the encoder were all healthy: what wedged is the
client's video display layer, and nothing in the reconnect path un-wedges it -- two transport
rebuilds at 00:27:29 and 00:27:39 left it black, which is why it never recovered on its own.

The reason this went unnoticed is that every "rendering" signal we have is measured at the wrong
end. `fps` counts frames handed TO `AVSampleBufferDisplayLayer`; `renderStallCount` watches the
enqueue cadence. Both read perfectly healthy while the layer emits nothing, so a wedged layer and
a working one are indistinguishable in the logs -- the same shape as the LTR gap in D225/D226,
where a mechanism's failure and its success printed identically. Two pieces of work, and the
observability comes first because the recovery cannot be verified without it: a display-side
signal (layer attached, bounds non-zero, samples actually dequeued or rendered), then a recovery
that acts on it. Note the client already has recovery paths for a wedged layer -- they just fire
on signals this state does not trip.

R231 detail: measured live during the same run: `scale=0.75` keyframe 86,644B at 00:34:00,
`scale=0.50` keyframe 68,598B at 00:34:06, `scale=0.75` keyframe 122,041B at 00:34:17. Three
resolution changes in seventeen seconds, each a full keyframe by construction, on the cellular
link least able to carry them. Separately `ltr-state-dropped` fired 25 times in eight minutes,
since every rescale recreates the compression session and destroys the long-term references.

The keyframe is not an implementation cost that could be optimised away, so do not go looking
for a cheaper rescale. Changing resolution requires an IDR at the bitstream level, because
HEVC has no reference picture resampling: a reference picture must match the dimensions of the
picture referencing it, and a new SPS activates only at an IRAP. It also requires a new
`VTCompressionSession`, whose dimensions are fixed at creation, which is what takes the LTR
references with it. The codecs that make a rescale cheap do exist (AV1, VP9, VVC all resample
references) and none of them is reachable: `VTCopyVideoEncoderList` on an M-series Mac returns
hardware encoders for H.264, HEVC, ProRes and JPEG only, with no AV1/VP9/VVC entry in either
hardware or software. The iPhone decodes AV1 and VVC and that is useless to us, because nothing
on the host can feed it. Doing it less often is the only lever available.

The shape is decoupling, not a blanket dwell. Today the ladder is a single ordinal emitting
three coupled values (`MediaQualityController.swift:834`), so there is no way to answer
congestion without dragging resolution along; a flat rate limit would therefore also delay the
bitrate and fps response, which is wrong. Split it: bitrate and fps follow the rung
immediately, since both are live session properties that cost nothing to change, and they are
the actual congestion response. Resolution moves only on sustained evidence.

Slower on that axis is the safer direction, which is the part that reads backwards. A rescale
during congestion is the most expensive single action the encoder can take, at the moment the
link can least carry it: answering "not enough bandwidth" with the largest possible frame
deepens what it is responding to. The cost we accept in exchange is a confirmation window of
high resolution at starved bitrate, which quantizes hard and blocks up around text, and clears
the instant bitrate recovers. Against seconds of nothing while a 120KB keyframe drains, that is
the better trade.

Thresholds should be asymmetric, because the climb back up has no urgency at all: the
122,041B frame at 00:34:17 was a return to 0.75 on a link that had just failed at it, and
nothing bad happens if that waits. Two of the five steps are already resolution-neutral
(native -> lossControl holds 1.00, capacity2 -> survival holds 0.50), so only three transitions
need gating. Worth checking before implementing: whether the oscillation is the ladder or the
estimator, since a radio transition can read as a capacity collapse and instant recovery within
seconds, and damping the axis would only hide that.

## v16 live Pi agent loop

- D232. Accept ADR-0091, move the product and technical contracts to an interactive Pi session,
  introduce capability-described sources and revisioned timeline items, and raise the outer wire to
  protocol v16 with complete Swift, TypeScript, and decoder tests.
- D233. Pin Pi 0.83.0, own `AgentSessionRuntime` and persisted JSONL behind a provider-neutral backend,
  add the bounded sequenced projection, authenticated HTTP/SSE, create/send/steer/abort commands,
  lifecycle cleanup, and hermetic backend/HTTP tests.
- D234. Carry correlated commands and timeline envelopes through the host bridge and authenticated
  phone session, preserving visibility-scoped fan-out, request idempotency, and independent viewers.
- D235. Add Pi session creation and the capability-driven composer to the existing virtual AgentPanel,
  with streaming replacement, queue/steer/stop state, scroll preservation, and Mac/mobile web tests.
- D236. Bind Pi extensions in RPC mode, project tool-only extensions and standard UI requests, resolve
  the first valid viewer response, and fail terminal-only custom UI explicitly.
- D237. Verify compiled-sidecar packaging, authenticated smokes, persisted reopen, two-subscriber bash
  streaming, focused tests, `just check`, and complete-diff self-review.
- R238. At the explicit runtime checkpoint, open the dev Mac/iPhone stack, create and steer one Pi
  session from both shared panels, answer one extension prompt from either viewer, and confirm the
  other viewer converges without a terminal or workspace surface appearing.
- D239. Make extension responses kind-valid and resolution-multiplexed, return the authoritative
  backend session descriptor on create, and pin the remaining protocol-v16 contract text and tests.
- D240. Correct the independent Pi arc review findings across replay recovery, live paging,
  sidecar credential isolation, native command validation, typed stream errors, extension prompt
  priority, durable session identity, catalog authority, timeline identity, runtime disposal, and
  the checked-in real-Pi smoke.
- D241. Rebase authoritative snapshots after runtime sequence resets, enforce native identifiers
  across every phone-originated thread read, and bound retained extension notices and unsupported
  widget warnings before replaying them to shared viewers.
- D242. Replace the complete visible event window when an authoritative reconnect snapshot resets
  Pi runtime-local indexes and revisions, instead of merging it with stale pre-reap rows.
- D243. Keep in-flight historical page reads from consuming or contaminating an authoritative
  reconnect snapshot across the host generation, bridge routing, and React state layers.
- D244. Remove the obsolete reconnect marker after snapshot kind and seeded-buffer state became
  the sole authoritative replacement route.
- D245. Register Pi's static Bun OAuth loaders before runtime creation, fail the compiled-sidecar
  build when the OpenAI Codex flow is not embedded, and show assistant runtime errors instead of
  rendering blank failure cards.
- D246. Replace the project/session drill-down with persistent responsive project navigation,
  independently streamed multi-project session previews, bounded reveal batches, accessible compact
  drawer behavior, and preserved Pi/thread controls.
