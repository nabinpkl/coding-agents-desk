# xterm.js WKWebView terminal spike

Throwaway code answering one question:

> Can the existing protocol-7 Rust PTY manager and bounded ANSI checkpoints drive two
> interactive xterm.js terminals inside one standalone macOS WKWebView, without touching
> or restarting the AgentDesk host?

This is not production code. It deliberately lives under `spikes/`, uses a test-owned
manager socket in `/tmp`, and launches as a separate process from the current checkout.

## Run

```bash
./spikes/xterm-wkwebview/run.sh
```

The command:

1. Installs the pinned web dependencies locally under this spike.
2. Bundles xterm.js and its fit/WebGL addons.
3. Builds the existing Rust PTY manager and starts a test-owned instance on a temporary
   Unix socket.
4. Builds and orders forward a standalone accessory AppKit executable containing one
   WKWebView, without activating it or making its window key.
5. Opens two real PTY sessions as two tabs inside that single web document.
6. Stops only the test-owned manager and removes its temporary socket after the spike exits.

The built-in self-test sends its marker directly through `PtyTerminalSessionDriver`, resizes
the window programmatically, reads xterm's buffer in JavaScript, and prints one JSON result.
It does not synthesize keyboard input or activate the spike.

The stable and dev AgentDesk hosts, their sockets, and their terminal sessions are never
read, killed, rebuilt, or restarted.

## What to exercise

- Switch between both tabs. They are separate xterm.js instances in one WKWebView.
- Type into both shells, including Unicode and pasted text.
- Resize the window and confirm the selected terminal reports its new capacity.
- Run a full-screen program such as `vim`, then switch tabs and return.
- Close and reopen the spike to confirm the test-owned state is disposable.

The footer exposes the renderer (`webgl` or browser fallback), source/view dimensions,
revision, suppressed renderer-generated replies, and native bridge errors.

The spike currently uses xterm's internal `coreService.onUserInput` source signal to
separate genuine keyboard/paste input from parser-generated terminal replies. The Rust
headless terminal remains the only component allowed to answer terminal protocol queries.
This private xterm seam must be replaced or deliberately pinned before a production move.
Incoming checkpoint resets and output writes are serialized per terminal because xterm's
parser is asynchronous; resetting the public terminal while older writes remain queued
otherwise leaks stale cells into the reconstructed frame.

## Observed background pass

The 2026-07-22 self-test completed with `focusPreserved=true`. Its direct PTY marker was
present before and after a source resize, while the xterm grid changed from `143×38` to
`93×21`. WebGL stayed active. The test-owned app and manager exited cleanly, and the
pre-existing PTY manager process remained untouched.

## What this does not prove

- iOS software-keyboard and VoiceOver behavior.
- Production throughput under sustained multi-megabyte output.
- Exact parity for every ANSI mode in the Rust checkpoint corpus.
- Production tab restoration or migration away from SwiftTerm.
