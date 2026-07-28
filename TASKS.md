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
- R155. Keep an unaccepted Custom Keyboard extension spike separate from the Voice and remote-input
  products. With Full Access enabled, a visible keyboard button writes a pending nonce to the shared
  App Group and asks iOS to open `agentdesk://keyboard-spike`. The containing app accepts only that
  pending nonce, records a matching receipt, and the returned keyboard reads it before offering a
  text-field insertion probe. This proves only extension installation, user-initiated URL transition,
  and App Group return state on a physical iPhone. It does not claim direct keyboard microphone access,
  background recording continuity, or App Store submission safety. It must not be included in a
  TestFlight build until the physical result and release posture are explicitly accepted.

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
- Generated 24 kHz mono PCM WAV and metadata pairs are atomic and retained under a configurable 2 GiB
  LRU cache. Cache keys include all pronunciation and executor inputs; cached audio is rehashed before
  playback, so a missing, partial, or corrupt pair is regenerated rather than trusted.
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
R155  implemented awaiting physical Full Access keyboard handoff and App Group return-path proof
```
