# DeskZoom

Zoom your Mac desktop out. DeskZoom adds a huge virtual display (7680x4800 at 1x by
default, room for about 100 mid-sized windows) and shows it in a window on your main
display that you can pinch-zoom and pan like a canvas.

- Title bar: zoom out, zoom in, 1:1 and Fit, with the current magnification shown. These work
  wherever the cursor is, which trackpad gestures cannot, so they are the reliable surface.
- ⌘= / ⌘- / ⌘1 / ⌘0: zoom in, zoom out, actual size, fit.
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

## Iterating

`just dev` takes about 2.7 seconds from command to live picture: 0.8s to compile, bundle and
sign, 1.3s for the window, 0.6s for frames to flow. A touched-file rebuild alone is 2.6s, a
clean build 9.5s. Every rebuild kills the app, which destroys the virtual display and creates
a new one, so the zoom level and the window's position are remembered and restored: an
iteration puts you back where you were looking rather than at the whole canvas.

## Fake cursor

A Mac has exactly one pointer and no way to make a second, so DeskZoom draws its own and never
asks the system to move anything. It is a pink arrow in the viewer, positioned in canvas
points, and pressing what sits under it goes through Accessibility, which hit-tests by
coordinate and needs no pointer and no focus. The real cursor stays wherever you left it and
the target app is not activated.

It is driven over a Unix socket at `/tmp/deskzoom.sock` (`--socket PATH` moves it), one line in
and one line out. `bin/deskzoom` wraps that, so put `bin` on your PATH:

```bash
deskzoom move 688 1165   # canvas points, from the top-left
deskzoom describe        # -> ok Calculator AXButton "5" actions=[AXPress]
deskzoom press           # -> ok pressed ...
deskzoom status          # -> ok canvas 2560x1600 cursor 688,1165 zoom 140%
deskzoom hide
deskzoom                 # the command list
```

The reply is printed, and one that starts with `error` exits non-zero so a script stops at the
first thing that did not happen. Under the hood it is `echo "move 688 1165" | nc -U
/tmp/deskzoom.sock`, and `DESKZOOM_SOCKET` follows a custom `--socket`.

`move-fraction 0.5 0.25` aims without knowing the canvas size. Moving the fake cursor pans the
view to keep it visible, the same way the real one does.

Windows and scrolling, so a script can aim without coordinates and read while it does:

```bash
deskzoom windows           # 0 TextEdit "Untitled" at 1400,300 900x650 ...
deskzoom move-window 0     # cursor to the middle of that window
deskzoom scroll 0          # to the top of whatever is under the cursor
deskzoom scroll-by 0.3     # down by 30% of its length; negative goes up
deskzoom scroll-x 1        # all the way right; scroll-x-by for a step
```

Scrolling is the scroll bar's own value, from 0 to 1, so it is absolute positioning rather than
a wheel: the equivalent of dragging the bar. The fake cursor is the anchor, and it stays put on
screen while the content moves under it, which is what a pointer over a scrolling view looks
like. Scroll wheel events posted to a process are ignored just as clicks are, and the page
actions a scroll area advertises returned "unsupported" in TextEdit, so the bar value is the
one mechanism relied on.

Typing goes to the application under the fake cursor, which is not activated: the real keyboard
keeps going wherever it was going.

```bash
deskzoom type hello world        # the rest of the line, as written
deskzoom key return              # one key; newlines inside type are sent as return too
deskzoom key cmd+a               # modifiers cmd shift alt ctrl, joined by +
deskzoom key cmd+shift+period    # punctuation by name, since + is the separator
```

The element under the cursor is given focus first, as a click there would have done, and the
keystrokes are posted to the process. Key names are US keyboard positions and `type` carries
the characters themselves, so text is layout-independent and `key` is not.

One limit: a chord with `cmd` only reaches the active application. Key equivalents and menu
actions travel the key window's responder chain, and an inactive app has no key window, so
`cmd+a` posted to it is dropped while `a`, `return` and `delete` land. Pressing the menu item
through Accessibility instead reports success and does the same nothing, apart from app-level
items such as Quit. `key` refuses a cmd chord unless the target is active, rather than report a
keystroke that went nowhere. There is no way around this that keeps your focus where it is:
making the window main and key through Accessibility, setting the app's focused window, pressing
the menu item, and a chord carrying its character all measured the same nothing. DeskZoom does
not change your active app, so cmd shortcuts are simply not available to the fake cursor; what a
menu does is usually reachable as a control with `find` and `press`.

`type` reads the element's text back after posting. When nothing changed, the app dropped the
keystrokes, and the text goes in through the Accessibility selected-text attribute instead, which
text fields and areas accept without any keystroke at all. The reply says which route was taken.

`deskzoom find Press me` moves the fake cursor onto the element whose title, description or text
contains the words, searching the window under the cursor first and then the rest of the canvas
front to back. Among matches it prefers the shortest name, so a button called "Press me" wins over
a page whose URL happens to contain the words. It replies with where it landed and what that is,
and the commands that act under the cursor act on that element for as long as the cursor stays
there, since a hit-test at an element's own centre does not always return it (Chrome answers with
a container for a button). The walk is bounded, since a web page can publish tens of thousands of
elements.

`deskzoom shot 0` writes a PNG of window 0, captured by window id through ScreenCaptureKit at the
canvas's pixel density, to `/tmp/deskzoom-0.png` or the file named after the index. A script can
read what it did from that without a screenshot of the whole screen. `deskzoom shot` alone writes
the whole canvas from the overview frame the viewer already holds, at the overview's resolution,
to `/tmp/deskzoom-canvas.png`, with no capture round trip.

What this can and cannot do follows from Accessibility, not from DeskZoom. Buttons, menu items,
checkboxes and anything else that publishes a press action work. Hovering, dragging, and apps
that draw their own content without publishing elements do not, because there is nothing to
press. Mouse events cannot substitute: `CGEventPostToPid` delivers them without moving the
cursor, but AppKit ignores them, since hit-testing is the window server's job and posting to a
process bypasses it. Keyboard events posted the same way are honoured. Measured 2026-09-04.

## Driving a second login session

An experiment, not part of the app. `tools/session-client.py` logs in to this Mac's own Screen
Sharing as a different user and drives that session. macOS starts a separate, concurrent login
session when a client authenticates as someone who is not the user at the console, and that
session has its own display, its own active application and its own keyboard focus. That is the
one thing the fake cursor cannot have: a command shortcut sent there reaches the active app
without moving the console user's focus. Verified 2026-09-04 end to end, with the console user
logged in and working the whole time: `cmd+space` opened Spotlight, TextEdit launched, text was
typed into it, and `cmd+a` selected it.

Apple's own client refuses to connect to the Mac it runs on, so this speaks RFB directly with
Apple's Diffie-Hellman and AES credential exchange, security type 30. Four things cost real time
to find:

- Command is `Super_L`. `Meta_L` and `Control_L` do nothing at all.
- The server discards input for roughly two seconds after a connection opens. Events sent
  immediately were dropped every time; the same events after a settle landed every time.
- A press needs a duration. Button down and up in the same instant is not a click a menu
  recognises, and the same is true of a keystroke.
- No special negotiation asks for the second session. Authenticating as a non-console user is
  the whole of it.

On pixels, VNC is the weaker path and is only worth it for crossing a session boundary.
ScreenCaptureKit hands over an IOSurface with no copy, which is what the viewer above uses. RFB
serialises pixels for a CPU to decode. Over loopback, measured on one 1920x1200 region:

| Encoding | Bytes | Time |
|---|---|---|
| Raw | 9.24 MB | 0.56 s |
| ZRLE | 1.78 MB | 0.88 s |

Compression is a net loss there, because loopback bandwidth is free and the server pays to
compress. Hardware decoding is not the question worth asking: an idle desktop sends nothing at
all, since an incremental update request simply blocks until something changes. Only motion
costs anything, and that is where a video codec, not a faster pixel decoder, would be the answer.

## How it works

- `Sources/CGVirtualDisplayPrivate`: header for the private CoreGraphics virtual display
  classes (the same ones BetterDisplay and DeskPad use).
- `VirtualDisplay.swift`: creates the display with one 1x mode.
- The overview alone serves 1920x1200 @2x, 2560x1600 @2x and 5120x3200 @1x completely, at any
  zoom, and serves every rung at Fit. The sharp capture only appears when zoomed in on one of
  the larger canvases.
- When the sharp capture does run, it is shown only while it covers the whole of what is being
  looked at. Half the window sharp and half of it overview, with the boundary sweeping across
  as you pan, *is* the flicker; the picture always has one sharpness instead.
- Re-aiming the sharp capture is rate limited to roughly three times a second. Every re-aim
  swaps the sharp picture for the blurred overview until the new stream delivers, so re-aiming
  on every pointer move reads as the windows flickering. Measured over a five second sweep of
  the whole canvas at 23x zoom: two re-aims, against well over a hundred before the limit.
- The whole canvas is captured continuously, at as much detail as a 17 megapixel budget
  allows, which is about what capturing a 5K display natively costs. A second, sharper capture of just the visible region runs only when that is not
  already enough, which on the small rungs and at Fit is never. Panning then has nothing to
  swap between, which is what flicker was: the picture alternating between the sharp region
  and the coarse stand-in as the view outran the re-aiming.
- `DisplayCapture.swift`: ScreenCaptureKit stream limited to the visible `sourceRect`, so
  zooming in never captures more pixels than the window can show. Re-aiming starts a fresh
  stream and keeps the old one painting until the new one delivers.
- `CanvasInputTap.swift`: event taps that boost pointer travel and take over pinch gestures
  while the pointer is on the canvas.
- `CanvasFocus.swift`: hands keyboard focus to whatever the teleported pointer lands on, and
  hit-tests and presses elements for the fake cursor.
- `ControlSocket.swift` and `ControlCommand.swift`: the shell-facing control channel;
  `Keystrokes.swift` is the keyboard side of it. `bin/deskzoom` is the shell end.
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
  Accessibility frontmost attribute works from an inactive app, but making an application
  frontmost does not move the active Space, so the display still is not the one new windows
  open on. Raising and focusing the specific *window* does move it, and that is enough on its
  own: verified with the click fallback switched off. Bare desktop has no window to focus, so
  entering the canvas there sends a plain click, which presses nothing and is the same thing
  a person would do.
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

## Desk size and sharpness

These are one axis, not two, and the title bar slider walks it while the app runs. The label
follows the knob as you drag; the display itself is reconfigured once you pause, since a mode
change takes about a second and dragging across the ladder would otherwise reconfigure at every
rung it passed. No restart, and the choice is remembered.

The framebuffer is fixed at what the hardware allows, around 7680 pixels wide on Apple
Silicon, and points and detail come out of it together. A canvas small enough that twice its
points still fit is drawn at two pixels per point and text stays sharp; a larger canvas is
drawn at one and holds more windows. On a 7680x4800 framebuffer the rungs come out as:

| Canvas | Backing | Room for |
|---|---|---|
| 7680x4800 | 1x | about 100 windows, softest |
| 6144x3840 | 1x | about 65 |
| 5120x3200 | 1x | about 45 |
| 3840x2400 | 2x | about 25, sharp text |
| 3072x1920 | 2x | about 16, sharp text |
| 2560x1600 | 2x | about 11, sharp text |
| 1920x1200 | 2x | about 6, sharp text |

A virtual display also advertises a pile of small legacy modes of its own, including 4:3 ones.
Those are filtered out: a 1024x640 canvas is not a desk, and a canvas of a different shape
would not fit the viewer.

At 1x the viewer runs out of detail around 237% zoom, where its window has as many physical
pixels as the region shows canvas points. At 2x that ceiling is twice as far in.

**Fit is not the sharpest view, and cannot be.** Fitting a canvas wider than the window shrinks
everything on it, and shrunk text is soft however many pixels back it. A 1920x1200 canvas in a
1674-point-wide window is displayed at 87% size. **1:1** (⌘1) sets the zoom so one canvas point
covers one window point, which on that canvas is 115%: text is then exactly the size and
sharpness it has on the display itself, matching the built-in screen. Use the slider to pick a
canvas whose 1:1 view frames what you want to work on.

A HiDPI mode is a *pair*. macOS makes one only when the display declares both the pixel-size
mode and the point-size mode that is exactly half of it, which is why the whole ladder is
declared up front. Setting the HiDPI flag with a single mode declared produces a plain 1x
display of that size, silently, which is what an earlier attempt here measured and wrongly
concluded from.

Separately, the capture is re-aimed once it is within 8% of the detail the window can show,
where it previously tolerated being 35% short. That is visibly soft text at rest for no reason.

## Limits

- Apple Silicon framebuffers top out at 7680 pixels wide; larger displays may be rejected
  or crash Catalyst apps.
- The viewer shows a picture. Windows only respond once the cursor is over there.
