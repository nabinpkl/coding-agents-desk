# DeskZoom

Zoom your Mac desktop out. DeskZoom adds a huge virtual display (7680x4800 at 1x by
default, room for about 100 mid-sized windows) and shows it in a window on your main
display that you can pinch-zoom and pan like a canvas.

- Title bar: zoom out, zoom in, and Fit, with the current magnification shown. These work
  wherever the cursor is, which trackpad gestures cannot, so they are the reliable surface.
- ⌘= / ⌘- / ⌘0: zoom in, zoom out, fit.
- While zoomed in, the view follows the cursor: reach the edge of the frame and it pans to
  keep the pointer on screen, so you can walk across the whole canvas magnified.
- Pinch: zooms the canvas around the pointer, wherever the pointer is. While it sits on the
  virtual display the gesture is taken over before any app sees it, so pinching never zooms
  the app underneath. Disable with `--pinch-zoom 0`.
- Two-finger scroll pans, but only while the DeskZoom window is focused and the pointer is
  over it.
- Click: move the cursor to that spot on the virtual display, and hand keyboard focus to the
  app under it, so the canvas becomes the active display and Spotlight opens things there. Whatever window is there now
  receives your clicks and typing. Move the mouse back across the display edge, or press
  ⌘B, to return.
- ⌘0: fit the whole display.

## Run

Requires Xcode 26 command line tools and [just](https://github.com/casey/just).

```bash
just dev
```

Two system prompts on first launch:

1. macOS 26 treats the new display like an AirPlay receiver and asks what to show on it.
   Choose **Extended Display**, tick **Set as Default** so it stops asking, and click Start.
   The window title tells you when DeskZoom is waiting on this.
2. Screen Recording. Allow it in the prompt or in System Settings › Privacy & Security;
   DeskZoom keeps retrying every few seconds, no relaunch needed.

Other sizes: `just dev-size 5120 3200`. If input ever feels laggy, run with `--pointer-gain 1`
to switch the pointer event tap off entirely and compare. The virtual display disappears when the app quits.
Move a window there by dragging its title bar off the right edge of your screen: the virtual
display sits immediately to the right in the arrangement, so the window crosses onto it and
appears in the viewer. Only the top-left band of the canvas, as tall as your physical screen,
can be entered this way; once across, drag it anywhere.

## How it works

- `Sources/CGVirtualDisplayPrivate`: header for the private CoreGraphics virtual display
  classes (the same ones BetterDisplay and DeskPad use).
- `VirtualDisplay.swift`: creates the display with one 1x mode.
- Re-aiming the sharp capture is rate limited to roughly three times a second. Every re-aim
  swaps the sharp picture for the blurred overview until the new stream delivers, so re-aiming
  on every pointer move reads as the windows flickering. Measured over a five second sweep of
  the whole canvas at 23x zoom: two re-aims, against well over a hundred before the limit.
- Two captures run: a permanent low-resolution one of the whole canvas, and a sharp one of
  the region being looked at. Panning and zooming outrun a capture stream, and the first fix
  for black bars only stopped the picture being letterboxed, not the area the sharp capture
  had not reached. That area now shows the overview, blurred, instead of background.
- `DisplayCapture.swift`: ScreenCaptureKit stream limited to the visible `sourceRect`, so
  zooming in never captures more pixels than the window can show. Re-aiming starts a fresh
  stream and keeps the old one painting until the new one delivers.
- `CanvasInputTap.swift`: event taps that boost pointer travel and take over pinch gestures
  while the pointer is on the canvas.
- `CanvasFocus.swift`: hands keyboard focus to whatever the teleported pointer lands on.
- `ZoomControls.swift`: the title bar accessory.
- `Viewport.swift`: pure zoom, pan, cursor-following and capture-region math, unit tested.
- `CanvasView.swift`: gestures, click-to-teleport, cursor presence highlight.

## Learnings (macOS 26.4, M2 Pro)

- The display does not come online until the user answers the "What do you want to show
  on" chooser. A timeout while waiting tears the display down; wait indefinitely.
- macOS ignores the single declared mode as the default and brings the display up at
  1920x1200, while still listing the declared 7680x4800 mode. `VirtualDisplay.selectDeclaredMode`
  switches to it with the public `CGConfigureDisplayWithDisplayMode`.
- ScreenCaptureKit returns `SCStreamError.userDeclined` immediately while the Screen
  Recording prompt is still open. Allowing it takes effect without a relaunch.
- The private API works unsandboxed with no entitlement; DeskPad's mach-lookup exception is
  only needed inside the App Sandbox.
- `SCStream.updateConfiguration` is the wrong tool for re-aiming a capture. A probe showed a
  reconfigured stream still delivering the previous region on its next frame, while a fresh
  stream had the new region on its first. Worse, ScreenCaptureKit emits nothing at all while
  a display is idle, so on a static desktop a reconfigured stream never repaints and zoom
  looks broken. DeskZoom starts a new stream per region and crops the frame already on
  screen with `CALayer.contentsRect` in the meantime.
- Never hold on to a capture's `CMSampleBuffer`. Retaining the displayed frame pins a buffer
  from the stream's pool, and once the pool has no free buffer ScreenCaptureKit stops
  delivering, silently: the picture just stops, with no error and no callback. The surface on
  screen is retained by CoreAnimation for as long as it is displayed, which is enough. Raising
  `queueDepth` only postpones the freeze; it was set to 1, then 3, and still froze after a few
  frames. The window title carries a frame counter now, because a stalled capture is otherwise
  indistinguishable from a canvas where nothing is happening.
- Do not combine `contentsGravity` with a clamped `contentsRect`. Clamping the crop to stay
  inside the frame changes its aspect ratio, and the gravity then letterboxes the picture into
  black bars. Positioning a content layer by frame is exact and cannot letterbox.
- macOS decides where a new window opens from the display holding the focused window, and
  focus follows clicks, never the pointer. Teleporting the pointer is not enough on its own.
- An inactive app cannot activate another one: `NSRunningApplication.activate()` is ignored,
  and so is activating ourselves first and then calling `activate(from:)`. Setting the
  Accessibility frontmost attribute works from an inactive app.
- `acceptsFirstMouse` matters here. AppKit spends the first click on an inactive app's window
  activating the app, so without it every click into the canvas was swallowed.
- Trackpad gestures reach an event tap as type 29, not the type 30 that AppKit reports to a
  focused app. Worse, a tap asking only for bit 29 receives nothing: only a tap requesting
  every event is given gestures at all. Both were measured with listen-only probes; the
  first cost two rounds of "pinch does nothing" before the probe was written.
- A gesture event's own location is not the pointer's, so a bounds check against it fails on
  a second display. Ask the window server for the pointer position instead.
- Pointer movement must be rewritten at the HID tap, where the cursor's position is decided.
  Rewriting it at the session tap changes only the coordinates an app is told about and the
  cursor does not move. Pinch gestures are the opposite: the window server synthesizes them,
  so they do not exist at the HID layer and need a session tap. Hence two taps on one thread.
- An *active* event tap must not live on the main run loop. The window server waits for the
  callback before delivering every event, so whenever the main thread was busy with capture
  setup or drawing, typing and pointing stalled machine-wide. It now runs on its own thread
  and caches the display bounds so the callback does almost no work.
- `SCShareableContent` is a window-server-wide query. Calling it on every re-aim, which
  cursor following made continuous, was expensive; the display is now looked up once.
- Re-aiming is skipped entirely while the viewport still sits inside the captured region at
  roughly the right detail, so panning costs no new streams.
- Measure a baseline before blaming a number. WindowServer sat near 40% CPU on this Mac with
  DeskZoom not running at all, so that reading was not evidence of anything.
- A title bar accessory is positioned from its view's frame. An autolayout-only view comes up
  zero-width and the whole accessory silently fails to appear.

## Limits

- Apple Silicon framebuffers top out at 7680 pixels wide; larger displays may be rejected
  or crash Catalyst apps.
- The viewer shows a picture. Windows only respond once the cursor is over there.
