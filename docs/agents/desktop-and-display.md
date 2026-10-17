# The virtual display, the agent session desk and display capture

Moved out of the root `AGENTS.md` on 2026-10-17 with the text unchanged. The root file still applies.
Read this before touching `deskzoom/`, the grid-encoder, or driving the agent session.

## The virtual display

- **The 8K desk is a process, and it lives in `deskzoom/`.** `deskzoom/.build/release/DeskZoom
  --display-only` creates one `CGVirtualDisplay` and holds it open; the display exists exactly as
  long as that process does. `~/Library/LaunchAgents/com.example.deskzoom.display.plist` supervises it
  (`Aqua` session type, `KeepAlive`, `RunAtLoad`), installed by `just display-install` from
  `deskzoom/justfile`. Nothing else in this repo creates a display: end that process and every
  desktop stream has nothing left to show.
- **Only the session at the console can create a display, whoever the user is.** One WindowServer
  serves every login session, and displays are a single global arrangement owned by whichever
  session is physically on the Mac. `CGVirtualDisplay` adds to that arrangement and takes no session
  argument; it cannot. Measured 2026-09-05 from both sides: called by `agent` off-console, the
  display landed on the console user's desktop with 29 modes and `agent` never saw it; called by the
  console user it works. Both accounts are admin and in `staff`, so permissions never entered into
  it. Put `agent` on the console and the roles flip exactly. The LaunchAgent therefore belongs to
  whoever holds the console (today `dev`), not to the session that uses the desk.
- **An off-console session gets a frozen copy, taken when the session was created.** Screen Sharing
  hands a non-console session synthesised displays: copies of the console arrangement as it stood at
  session creation, one fixed mode each. Nothing added to the real arrangement later reaches it, and
  the copy is not linked to its original, so it survives the original being destroyed. That is why
  the current route works at all: the 8K was created on the console, recreating the agent session
  snapshotted it, and the copy outlived the console original.
- **Changing the agent session's desk is a sequence, not a setting.** The copy is frozen at one mode,
  so reconfiguring the console 8K does not reach it and DeskZoom's runtime mode ladder is
  unreachable from there. Set the console display to the mode you want, log the agent session out,
  reconnect over Screen Sharing to recreate it, then confirm with `--list-displays` run *inside that
  session*, which is the only way to see what Screen Sharing synthesised: System Settings is a GUI
  and `system_profiler` reports hardware, neither answers for a session.
- **Only one virtual display exists at a time.** `CGVirtualDisplay.apply` returns false for a second
  one whatever its size, measured at both 7680x4320 and 1440x900. Handing the display from one
  holder to another means the old one lets go first, so there is a gap with no desk at all.
- Open, not settled: whether ScreenCaptureKit in an off-console session can capture a synthesised
  display that is not that session's main one. If it cannot, the console's main display has to be
  the 8K at agent-session-creation time.

## Running commands in the agent session

- **Use the helper's `window-input` verb, not VNC typing.** `POST /api/window/input` with a Terminal
  window id and `{"type":"text","text":"...\n"}` runs a command in that session: the helper posts
  the keystrokes in-process, and `text` presses Return on a newline. Measured 2026-09-06 on the same
  command: **0.15s**, against ~12s for a script invoked over VNC and 33s+ for typing the line
  through VNC. Get the window id from `/api/park/state` or `/api/window/audit`.
- **VNC has no command channel and never will.** RFB carries framebuffer updates out and key and
  pointer events in; there is no "run this" message, so a command has to be typed one keysym at a
  time with a hold and a gap. Its own bulk-text message, `ClientCutText`, does not work against
  Apple's screensharingd: measured, the server took it and the clipboard stayed empty. Keep
  `deskzoom/tools/session-client.py` for what it is genuinely good at -- looking at the screen
  (`shot`) and driving pointer gestures -- and reach for `batch` only when the sidecar or its helper
  is not up to answer.
- `ssh` is not an option today: Remote Login is off, though `agent` is already in
  `com.apple.access_ssh`. It would also only cover half the work, because an ssh session has no
  WindowServer connection and so cannot drive Accessibility, raise a window, or post to that desk.

## Display capture

- **Two grid-encoders must never run from one executable path.** replayd, the daemon behind
  ScreenCaptureKit, files every stream client that runs from one path under a single RPClient
  and, when any one of those processes disconnects, stops all of that client's streams ("Stream
  was stopped by the system" / "application connection being interrupted"). Measured 2026-09-05
  with two encoders on one display: SIGTERM to one ended the other within 100 ms; a byte-identical
  copy at another path was untouched. The sidecar therefore spawns each encoder from its own
  numbered copy under the runtime `bin/grid-encoder-slots/` (see
  `agent-feed/sidecar/src/desktop/encoderSlots.ts`). A probe encoder started by hand from the
  installed binary kills the sidecar's live capture the moment it exits; run probes from a copy.
- **`--codec` is required, and both values are Annex-B.** It used to default to `hevc-fmp4`, the
  fragmented-MP4 mode that fed the MSE path, and the stdin loop owning desktop control -- input,
  space navigation, keyframe and bitrate commands -- ran only on the annexb path. So a probe that
  forgot the flag captured and emitted cursor frames exactly as usual while answering nothing at
  all on stdin, which reads as a broken build rather than a wrong invocation (measured 2026-09-05).
  The MSE path was removed on 2026-09-06 and the flag made mandatory, so that trap is closed
  rather than documented; the note stays because an older helper still on a machine has it.
- **Stdin EOF ends a capture.** The helper reads it as "the owner is gone" and exits, which is what
  makes a sidecar reload, crash or kill take its encoders with it. A capture started by hand with
  stdin at `/dev/null` therefore exits immediately; keep stdin open, as sending commands requires
  anyway.
- **See who is streaming before blaming the stream.** `just webrtc-sessions [user]` lists live
  viewers and encoders for that login session's sidecar; `just webrtc-close [user]` ends them
  all, or one with `attempt=` / `pid=`. The diagnostics log for a session is
  `/Users/Shared/agentdesk/logs/<user>-webrtc-diag.log`; encoder lines carry a geometry tag
  (`whole@…` or `x,y,w,h@WxH`) and the slot the encoder ran from.
