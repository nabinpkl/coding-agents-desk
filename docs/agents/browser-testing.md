# Browser testing

Moved out of the root `AGENTS.md` on 2026-10-17 with the text unchanged. The root file still applies.
Read this before verifying a panel change in a browser.

## Browser testing

- **Verify your own work in Chrome for Testing, not in the owner's Chrome.** Playwright's Chrome
  for Testing is what this repo already drives autonomously (`chrome-test/*.mjs`, `just
  dom-mirror-cdp-verify` and its siblings), and it is the default for every question about a change
  you just made: does the surface render it, does the control do what it says, did the number move.
  It gives an independent CDP session, a throwaway profile, console and network from page load
  rather than from whenever a tool attached, and it can be reloaded and killed freely. The panel
  needs no credential to load -- the tailnet is the auth boundary, `AGENT_FEED_HOST` and WireGuard,
  not a login -- so a fresh profile at the dev origin is the real panel with the real sessions in
  it, not a degraded copy.

  **The owner's Chrome answers one question: what is on the owner's screen right now.** Reach for
  the extension tools (`mcp__claude-in-chrome__*`) when that IS the question -- a surface the owner
  says looks wrong, a stream only their tab is holding -- and not to confirm work you can confirm
  yourself. Never the in-app preview browser, which reproduces neither. Two standing costs make
  this the narrow case rather than the default: a tab the owner is not looking at is throttled and
  lies to you in both directions (the two bullets below), and opening the Desktop surfaces from a
  second client makes the sidecar cycle encoders underneath the owner's own stream. A tab you open
  in their Chrome is yours to close when you are done with it.

- **Several agents share this machine, so a Chrome for Testing profile belongs to the RUN, not to
  the script.** Chrome keeps a `SingletonLock` in its user-data-dir: a second instance pointed at
  the same path either attaches to the first browser or refuses to start, so two agents running one
  verifier at the same time is not a slow test, it is a test that reports on someone else's
  browser. The same is true of anything else a harness pins by name -- a port, a socket, a fixture
  file.

  The shape most of `chrome-test/` already uses is the one to copy: `mkdtempSync(join(tmpdir(),
  '<harness>-'))` for the whole working directory, the profile inside it, `listen(0)` for every
  fixture server so the kernel picks the port, and a `teardown` that closes the context and does
  `rmSync(work, { recursive: true, force: true })`, wired to a watchdog timer so a hung run still
  cleans up before exiting non-zero. `input-verify.mjs`, `scroll-verify.mjs`, `record-verify.mjs`,
  `e2e-chrome.mjs` and `browser-projection-e2e.mjs` all do exactly this.

  **Clean up, and do not leave the mess in the repo.** A profile is tens of megabytes and a killed
  run leaves the whole directory behind, so `/tmp` fills with them silently. Never put one under
  the working tree: `cdp-verify.mjs` pinned `.cdp-verify-profile/` at the repo root until
  2026-09-14, which is why that path is still in `.gitignore` -- one fixed name that both collided
  between two agents and left a profile inside the checkout every time a run was killed.

  One constraint pulls the other way and is easy to trip over while making paths unique: a Unix
  socket path has a hard length limit (`SUN_LEN`, 104 bytes on macOS), and a long unique directory
  under `$TMPDIR` blows through it. The failure is a daemon that dies at startup with an empty log.
  Keep sockets short and rooted at `/tmp` even when the profile lives in a long unique path.

- **When the page stops responding, verify in a DEBUG Chrome, not the owner's.** The extension's
  tools run inside the tab they are inspecting: `javascript_tool` is a CDP `Runtime.evaluate`, so a
  renderer that is frozen, spinning, or backgrounded fails it with a 45s timeout, and
  `read_console_messages` and `read_network_requests` come back empty because their tracking never
  started. All three are then reporting on the probe rather than the page, and reading them harder
  tells you nothing.

  So the answer is the same Chrome for Testing this section opens with, pointed at the panel's dev
  origin the way those harnesses point it at their fixtures. What matters here is the specific
  reason: its console and network start at page load rather than whenever a tool attached, and
  nothing it reports is coming from inside the renderer you are asking about.

  Do NOT reach for `mcp__computer-use__app_screenshot` on the owner's Chrome for this. Browsers are
  granted at computer-use's `read` tier, so it can only show what is already on screen, and it
  raises a permission dialog the owner has to answer -- a prompt for a strictly worse observation
  than the debug browser gives for free. `preview_logs` and the dev server's own log are the other
  outside views; a healthy `/api/config` alongside a frozen tab is what tells you the freeze is the
  page and not the server.

- **A screenshot of a HIDDEN panel tab draws rows on top of each other, and the page is fine.**
  Measured 2026-09-10, after chasing it. A hidden tab gets no rendering updates, so React commits a
  row's taller content while the ResizeObserver notification that moves the rows BELOW it is never
  delivered. `captureScreenshot` forces a frame anyway, and paints the new content at the old
  positions: a streaming transcript comes back with prose written across the tool rows under it,
  several places at once, stable enough across two screenshots to read as a layout bug.

  Two tells, both cheap. `document.hidden` is `true`. And running ANY `javascript_tool` call first
  flushes the pending work, so the very next screenshot is nearly clean -- which also means a probe
  INSIDE that tab can never catch this: `setInterval` is clamped to about once a minute after five
  minutes hidden, and the evaluate that reads the DOM is itself what fixes the state you were
  trying to measure. Both of mine reported zero while the screenshot showed the opposite.

  Settle it in Chrome for Testing, which is visible. Seed `agent-panel.selection` in
  `addInitScript` the way `chrome-test/panel-scroll-memory-verify.mjs` does, then sample each row's
  `translateY` against its `offsetHeight`. Two runs against one live streaming session: 734 samples
  over 110s (588 with live rows on screen) and 401 over 60s (377 with live rows), and not one row
  more than 2px out of place in either.

- **Verifying anything you DRIVE belongs in a debug Chrome you control, not the owner's tab.**
  The bullet above is about a tab that stopped responding; this one bites while the page is
  perfectly healthy. A backgrounded tab takes clicks and never takes typing. Measured 2026-09-11
  on the question mirror: `.click()` on a radio updated React exactly as a person would, and both
  ways of typing into a text field beside it -- the native value setter plus a bubbling `input`
  event, and real keystrokes through `computer`'s `type` -- left the DOM value set and React state
  untouched, or did nothing at all. `document.hidden` was `true` throughout and `document.hasFocus()`
  was `true`, so neither one warns you. The result reads as a broken control, which is what it
  looked like for the twenty minutes spent on it.

  This is the sharpest reason the default runs the other way. **Driving** anything -- typing,
  submitting, anything whose whole point is that an input event arrived -- needs a visible,
  foregrounded browser that nothing is competing for, and that is Chrome for Testing. The owner's
  Chrome cannot be it: the tab you want is behind whatever they are actually reading, and a
  backgrounded tab takes your clicks while silently dropping your typing. Where the owner's tab is
  genuinely the subject -- a stream only it is holding, a state only it is in -- read it there and
  drive the reproduction elsewhere, and do not read a null result from a throttled tab as an answer
  about the page.

  The general rule under it is the absent-result one in `docs/agents/debugging.md`, with a twist worth naming:
  here the probe produced an ABSENCE OF EFFECT rather than an absence of data, and an effect that
  did not happen is just as cheap for a broken probe to produce as an empty result is.
