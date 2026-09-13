# Directory clustering ledger

Bringing every directory in the two live TypeScript trees under the twelve-source-file ceiling
`AGENTS.md` states in "How long a file gets, and how flat a directory gets".

Scope is `packages/AgentPanel/Web/src/**` and `agent-feed/sidecar/src/**`, and nothing else.
`agent-feed/wire/` is the contract both ends compile against and is not moved.

The rule, as it decides each task below:

- Twelve source files per directory is the ceiling. A test rides with its source: `foo.ts` and
  `foo.test.ts` are one thing.
- Three files is the floor for a new directory. One or two stay flat.
- One clustering level below a feature. A second needs its reason written in `## Decisions`.
- Only fan-out promotes a cluster. The list going past twelve AND three or more files being about
  the same thing is what earns a directory. Concepts do not earn directories, counts do.

Behaviour does not change and no file's contents change beyond its import lines. This is `git mv`
plus the import edits the move forces.

## Tasks

Measured 2026-09-09 on `d75ccace`, `source files (all files) path`, worst first.

| ID | State | Source files | Directory |
|---|---|---|---|
| R1 | D | 53 -> 5 (parent) | `packages/AgentPanel/Web/src/features/desktop-viewer` |
| R2 | R | 36 (62) | `agent-feed/sidecar/src/http` |
| R3 | R | 26 (44) | `packages/AgentPanel/Web/src/features/activity-feed` |
| R4 | R | 24 (50) | `packages/AgentPanel/Web/src/app` |
| R5 | R | 20 (23) | `packages/AgentPanel/Web/src/features/bots` |
| R6 | R | 17 (23) | `agent-feed/sidecar/src/transcripts` |
| R7 | R | 16 (24) | `agent-feed/sidecar/src/terminal` |
| R8 | R | 15 (21) | `agent-feed/sidecar/src/transcripts/sources` |
| R9 | R | 13 (18) | `packages/AgentPanel/Web/src/features/terminal` |
| R10 | R | 13 (13) | `packages/AgentPanel/Web/src/features/session-view` |
| R11 | R | - | Check 6 in `tools/agent-feed-fitness.sh` and the same count in `tools/git-hooks/pre-commit` |

Re-measure after every task, because moving files out of a parent changes the parent's count and
can put a child over:

```
for d in $(find packages/AgentPanel/Web/src agent-feed/sidecar/src -type d); do s=$(find "$d" -maxdepth 1 -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.*' | wc -l | tr -d ' '); [ "$s" -gt 12 ] && echo "$s $d"; done | sort -rn
```

## R1 `features/desktop-viewer`, 53 source files

Groups, written before anything moved:

- `keyboard-deck/` (6) the drawn iPhone keyboard: its layout, its measurements, which key a touch
  belongs to, and the two components that render it. `KeyboardDeck`, `KeyboardDeckKeycap`,
  `keyboardDeckHitTest`, `keyboardDeckMetrics`, `keyboardDeckModel`, `keyboardDeckTestLayout`.
- `keyboard-input/` (10) what a keypress becomes on the wire: the hidden capture field, the send
  path, what the Mac acknowledges, the session state, the reader's preference, the hook that owns
  them and the chrome that assembles them. `DesktopKeyboardChrome`, `desktopKeyboardCapture`,
  `desktopKeyboardContext`, `desktopKeyboardControl`, `desktopKeyboardModel`,
  `desktopKeyboardPreferences`, `desktopKeyboardSend`, `desktopKeyboardSession`,
  `useDesktopKeyboard`, `useDesktopKeyboardHarness`.
- `tile-stream/` (8) the WebRTC leg: one attempt at a stream, the control channel it negotiates,
  the two HTTP calls beside the offer, and everything that reports whether frames are arriving.
  `TileStreamRtc`, `tileStreamSession`, `tileControlChannel`, `tileReceiverStats`,
  `tileVideoPresentation`, `webrtcReceiverStats`, `webrtcTileCapture`, `webrtcTileWire`.
- `tile-viewport/` (10) the surface the picture is shown on and everything one mounted viewport
  holds: the component, its runtime, its arithmetic, its constants, and the marks it draws.
  `TileViewport`, `TileViewportOverlays`, `tileViewportHarness`, `tileViewportRuntime`,
  `tileViewportConstants`, `tileViewportFrame`, `tileViewportMath`, `tileViewportDragVisuals`,
  `tileViewportCursorMirror`, `cursorImageCache`.
- `tile-gestures/` (4) what a pointer, a wheel or the puck turns out to be. `tileViewportPointerHandlers`,
  `tileViewportScrolling`, `tileViewportPuck`, `tileViewportGestureTelemetry`.
- `zoom/` (7) the two zoom models and the capture the crop model re-aims. `zoomMode`, `zoomModels`,
  `visibleRect`, `captureCrop`, `captureScale`, `overviewLayer`, `tileCapturePlan`.
- `navigation/` (3) moving between desktops. `DesktopNavigationChrome`, `desktopNavigationModel`,
  `useDesktopNavigation`.

Dropped, below the floor of three: nothing. Left flat (5): `DesktopViewer`,
`DesktopViewerControls`, `DesktopViewerStreams`, `DesktopViewerSurface`, `DesktopStreamState`.

## Decisions

## Deferred
