# Handover: host-side dictation bar

For the next agent picking up the AgentDesk macOS host dictation feature. Read `AGENTS.md` first (it loads the universal worker rules, `PRD.md`, and `SPEC.md`). This doc only covers what those artifacts do not. The previous handover (post-R19 input transport split) is preserved in this file's git history; its still-open v0 items are summarised at the bottom.

## What the feature is

A host-local push-to-talk dictation bar on the Mac. Hold the mic button or the Fn/Globe key, speak, release; the clip is captured in memory, POSTed to a localhost OpenAI-compatible transcription server, and the returned text is typed at the focused cursor and shown briefly in the bar.

Authoritative detail lives in:
- `architecture-decisions/0010-host-mic-dictation.md` (design, rejected options, constraints).
- `SPEC.md` Host module boundary 13 (DictationBar) and the stack notes.
- `PRD.md` "What v0 is not" (the audio non-goal was reopened for this host-local utility only).

## Current state

Shipped and on `main`. All work is committed and pushed; `just check` is green (host + client targets). Commits, newest first.

Host overlay appearance and overlap (latest session): `2bb5134` the dictation bar is now a white pill, `3c0100a` keep the dictation bar clear of the SpaceAgent handle, `c72d3f8` pin the SpaceAgent overlay to dark appearance. Two of these supersede dead ends: `215e2cd` first pinned the dictation bar to dark for the old dark pill, then `2bb5134` switched it to the white look; and a misdirected client-side strip restyle `c2df795` was reverted whole in `252369e` (the wash-out it chased was actually the SpaceAgent overlay, not the iPhone client).

Dictation feature: `35878fe` compact-bar-widens-for-content, `b9567da` Fn-key push-to-talk, `b346280` trailing space after transcript, `140ce80` type transcript at cursor, `08610d9` OpenAI-compatible endpoint, `681ef7f` level meter, `a00341f` draggable/persistent, `b1d2b80` initial feature. Use `git show <hash>` for any one.

The dictation bar is a white pill, pinned light (`root.appearance = .aqua`, container filled white with a `separatorColor` hairline, foreground moved to `labelColor`/`secondaryLabelColor` and the meter's unlit bars to black-alpha).

The SpaceAgent now splits its appearance by surface. The expanded tile strip stays dark glass in both system modes, but the pin moved off `rootView` and down onto just the `.hudWindow` backdrop (`tileBackdrop.appearance = .darkAqua` in `SpaceAgentViewController.configure`); that material is the only appearance-sensitive piece (it goes light under the system light appearance and strands the white captions). `rootView` is now left unpinned so the collapsed handle follows the system appearance: `SpaceAgentHandleView.draw` reads `effectiveAppearance.bestMatch` and paints a white pill in light mode (rocket seated in a gray disc, mirroring the dictation mic's white-pill-plus-gray-circle look) or the old near-black pill in dark mode, and `viewDidChangeEffectiveAppearance` triggers the redraw on a system mode switch.

Files (all under `host/AgentDeskHost/`): `MicRecorder.swift`, `WAVEncoder.swift`, `TranscriptionClient.swift`, `DictationBar/DictationBarController.swift`, `DictationBar/DictationBarViewController.swift`, plus wiring in `AppDelegate.swift`, knobs in `Config.swift`, `Info.plist` (mic usage + `NSAllowsLocalNetworking`), and `AgentDeskHost.entitlements` (mic under Hardened Runtime). Test: `host/AgentDeskHostTests/WAVEncoderTests.swift`. Project file `host/AgentDeskHost.xcodeproj/project.pbxproj` registers each new source manually; this project uses explicit file references, not synced folders, so any new file must be added there too. To avoid that step for one new test, the SpaceAgent-handle placement tests were appended to the already-registered `host/AgentDeskHostTests/SpaceAgentModelTests.swift` (struct `SpaceAgentPanelPlacementTests`).

Overlap avoidance spans both overlays: `SpaceAgentPanelPlacement.nonOverlappingOrigin` (in `SpaceAgent/SpaceAgentController.swift`, next to `clampedOrigin`) does the math; `SpaceAgentController` exposes `currentHandleScreenFrame()` and fires `onHandleFrameDidChange` on every handle move (drag, expand, collapse); `DictationBarController` holds a `spaceAgentHandleFrame` provider and a `keepClearOfSpaceAgentHandle()` entry point, and `AppDelegate.startDictationBar` wires the two (provider set before `start()` so even first placement dodges).

## Verified vs not

- Verified: builds, unit tests pass (`just check`), including the WAV header test and the two `SpaceAgentPanelPlacementTests` (the dodge math: returns the proposed origin when clear, slides clear and stays on-screen when overlapping).
- NOT verified end to end: live mic capture, the transcription round-trip, and cursor typing. These need a physical mic, the one-time TCC mic prompt, and the transcription server running. They cannot be driven headless. The next agent or the user must confirm in the real app. This is the most important open item for the feature.
- NOT visually verified: the appearance work this session. The white dictation pill, the dark SpaceAgent strip, and the bar dodging out from under the spaceship all pass build and the placement unit tests, but rendered appearance and the live dodge cannot be checked headless. Confirm on a real Mac in both light and dark mode.

## How to run and test

1. Start the OpenAI-compatible transcription server on `http://localhost:8000` (endpoint `/v1/audio/transcriptions`, multipart fields `file` + `model`, response `{ "text": ... }`).
2. `just host-run` (builds Debug, relaunches via LaunchServices so TCC attributes permissions to the app, not the terminal).
3. Grant Microphone and Accessibility if prompted. Accessibility is what lets the global Fn monitor fire and what gates cursor typing.
4. Trigger: hold the mic button in the bottom-centre bar, or hold Fn/Globe. Release to transcribe. Text types into whatever app is frontmost (the bar is a non-activating panel, so focus stays put).
5. Logs: `just host-logs`, categories `dictation`, `mic`, `input`.

Config knobs (documented in `.env.example`): `AGENTDESK_TRANSCRIBE_URL`, `AGENTDESK_TRANSCRIBE_MODEL` (default `mlx-community/whisper-large-v3-turbo`). Set via `launchctl setenv` before `open`, per the host-run pattern.

## Gotchas specific to this feature

- Mic under Hardened Runtime requires the `com.apple.security.device.audio-input` entitlement; that is why the entitlements file exists. Removing it silently breaks mic access.
- `http://localhost` works only because of the `NSAllowsLocalNetworking` ATS exception in `Info.plist`.
- Fn/Globe behaviour can collide with System Settings > Keyboard > "Press Globe key to". If a single Fn press pops the emoji/input UI, that setting is the cause, not our code.
- Capture is in-memory by hard requirement (ADR-0010). Do not introduce `AVAudioRecorder` or any temp-file path.
- Transcript is typed with a trailing space; the bar auto-collapses about 4s after showing text (`transcriptDismissDelay` constant in the controller).
- The bar anchors to `NSScreen.main` only; multi-display is not handled.
- The dictation bar and the SpaceAgent handle are sibling borderless non-activating floating panels. Where they overlap the front panel swallows the press, and the mic button uses `acceptsFirstMouse` and records on `mouseDown`, so a press meant for the spaceship that lands on the mic starts a recording. The dodge wiring above prevents this. Removing it (or the provider) makes "dragging the space agent triggers dictation" come back.
- The dictation pill is pinned `.aqua` and the SpaceAgent expanded backdrop is pinned `.darkAqua` on purpose. Do not remove those two pins to "support light/dark mode": those surfaces' colours are hardcoded or semantic and tuned for one fixed surface, so dropping the pin reintroduces the wash-out (white-on-white captions on the strip, white-on-white text in the pill). The SpaceAgent collapsed handle is the deliberate exception: it is unpinned and draws per `effectiveAppearance`, so it does follow the system. If you change either overlay's surface colour, recolour its foreground in the same change.

## Open follow-ups for the dictation feature (not started)

- Fixed-duration auto-stop for recording was offered and declined for now; revisit if push-to-talk hold is awkward.
- Programmatic resize does not persist the compact resting origin (only user drags are saved via `windowDidMove`). Minor; revisit if the bar drifts after collapse.
- The dodge re-runs on every `onHandleFrameDidChange`, which fires per move event while the spaceship is dragged. If it looks jumpy, debounce it or only dodge on drag-end.
- The mic still has no tap-vs-drag tolerance: `acceptsFirstMouse` plus record-on-`mouseDown` means any stray press on the mic records. The dodge removes the panel-overlap cause; a press-becomes-drag cancel in `PushToTalkButton` would be the belt-and-suspenders fix.
- Idle mic tint is `.systemGray`, which reads softer on the new white pill than the old near-black on dark. Darken to `labelColor` if it looks faint.
- End-to-end live verification (above).

## Other v0 work still open (carried from the prior handover)

These are unrelated to dictation but were open before this session. Detail is in the previous version of this file (git history) and in `TASKS.md`.

- R11.1-R11.4: Spaces enumeration + 3-finger swipe. AFK, not started.
- R13.3: HITL hardware timing measurement on the physical iPhone. Only the human can close.
- R14.1-R14.4: distribution + 7-day self-test. Blocked on the Apple Developer Program cert and R11.

General repo gotchas from the prior handover that still apply: wipe `~/Library/Application Support/AgentDesk/` if a resigned host build hits "Operation not permitted" on pairing (stale `com.apple.provenance` xattrs); SourceKit reports spurious missing-type errors for same-module symbols, `xcodebuild` builds clean; Maestro needs `JAVA_HOME` (the `ui-flow` recipe sets it).

## Suggested skills

- `run` or `verify` to launch the host and confirm the live dictation flow (the unverified part above).
- `code-review` on the dictation diff if you change the capture or typing path.
- `diagnose` if mic capture or the transcription round-trip misbehaves.
