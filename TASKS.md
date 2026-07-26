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
```
