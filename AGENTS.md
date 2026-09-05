# DeskZoom

A zoomable canvas of real macOS windows. The app creates a large 1x virtual display
(default 7680x4800), captures only the visible region of it with ScreenCaptureKit, and shows
that in a window on the main display. Pinch zooms, two-finger scroll pans, a click teleports
the cursor to that spot on the virtual display so the real windows there take input.

## Type and definition of done

Daily tool for the owner. Done means the owner keeps 20+ windows on the virtual display and
reaches them through DeskZoom during a normal work day. Kickoff interview was waived by the
owner on 2026-09-04.

## Gap claim

Built instead of reusing: BetterDisplay (PIP viewer is paid), DeskPad (caps the display at
5120x2160, forces HiDPI which halves the space, uses the deprecated CGDisplayStream, and the
owner considers it dead). Verified by reading DeskPad's source on 2026-09-04.

## v0 scope (literal)

- One virtual display whose framebuffer size comes from `--width/--height`. It declares a
  ladder of canvases underneath that, and a title bar slider moves between them while running:
  small canvases are backed at two pixels per point, large ones at one.
- Viewer window: aspect-locked, pinch zoom, scroll pan, click teleports cursor, ⌘B brings
  the cursor back to the main display.
- Zoom lives in the title bar (out / in / Fit plus a magnification readout) and on ⌘= ⌘- ⌘0,
  because gestures only reach DeskZoom while its window is focused.
- While zoomed in the view follows the cursor, panning to keep it inside a margin.
- Clicking into the canvas hands keyboard focus to the app under the pointer, falling back to
  the Finder, so the virtual display becomes the display macOS opens new windows on.
- Capture follows the viewport by starting a fresh stream per region, 60 fps cap, with
  `CALayer.contentsRect` cropping the current frame until the new stream delivers.
- Pointer travel on the canvas is boosted with a speed-dependent gain (`--pointer-gain`,
  default 3), and pinch gestures made on the canvas are taken over to zoom it
  (`--pinch-zoom 0` to disable). Both use event taps and need the Accessibility grant.
- The zoom level and window position survive a rebuild, since every rebuild recreates the
  virtual display and would otherwise interrupt whatever was being worked on.
- A fake cursor drawn in the viewer, driven over a Unix socket (`bin/deskzoom`, `--socket`),
  pressing and scrolling through Accessibility and typing by posting keystrokes to the process,
  so the real pointer never moves and the active app changes only on an explicit `activate`.
  `shot <n>` captures one canvas window by id.
- Fail loud: any capture or display error shows an alert and exits.

Deferred (propose in one line, do not build): multiple virtual displays, remembered window
layouts, overview labels per window, HiDPI modes, menu bar mode, preferences UI.

## Conventions

- SwiftPM only, no Xcode project. `just check` before committing, `just dev` to run.
- `Sources/CGVirtualDisplayPrivate` is the only private API; everything else is public SDK.
  If it breaks after an OS update, that is the first suspect.
- The app is not sandboxed and must stay unsandboxed (ScreenCaptureKit on another display,
  cursor warping).
- Dev builds are signed with the Apple Development identity so the Screen Recording grant
  is not re-prompted per build. `just reset-tcc` clears a stale grant.
- The window title shows the short git sha of the running build. Compare it with
  `git rev-parse --short HEAD` before trusting what you see.

## Exhaust landing

Learnings about CGVirtualDisplay and ScreenCaptureKit region capture land in README.md.
20-hour checkpoint: ask whether an external artifact ships or the project is killed.

## Ending a response

Agent responses end with exactly three concrete next directions the owner may ignore.
