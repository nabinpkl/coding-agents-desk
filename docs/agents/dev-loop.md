# The dev loop: launching, supervising and deploying on this Mac

Moved out of the root `AGENTS.md` on 2026-10-17 with the text unchanged. The root file still applies.
Read this before `just host-run`, before touching the dev server or the supervisor, and when a surface
looks like it is running old code.

## Bringing the current path up

`just host-run` is the whole setup, and it is a **stop-and-wait checkpoint**: prepare it, state it,
then wait for the user to say run it. It builds and launches the Mac host, which is not itself the
loop -- it is what supervises the two pieces that are: the panel's Vite dev server and the
agent-feed sidecar. Both are live by default, so an edit to either reaches every attached surface
with no rebuild, no reinstall, and no re-pair.

- **`panel` (`live` default | `bundled`)** starts the panel's Vite server if it is not up, waits for
  it to answer, and points the launch at it. The launch FAILS if that server cannot come up, because
  the dev origin is not a fallback. Pass `bundled` to judge the panel as it actually ships
  (ADR-0095, ADR-0096).
- **`sidecar` (`live` default | `bundled`)** spawns `agent-feed/sidecar/src/supervisor.ts` instead
  of the compiled binary. The supervisor owns the server as a child, watches the tree, PARSES what
  changed, and replaces the child only once every changed file is whole and the tree's imports
  resolve -- so this arm executes the working tree without a half-saved file, or a caller saved
  before its callee, being what runs (`supervisor/supervisorLinks.ts`: `Bun.build` in a CHILD
  `bun`, ~40ms, killed after 10s; run in-process it froze the supervisor on a native lock on
  2026-10-14, heartbeat and all, while the sidecar served stale code). And only once the tree
  typechecks with no error the running tree did not already have (`supervisor/typecheck.ts`,
  TypeScript 7 in a child, a second or two): a call saved before the declaration it names resolves
  and then dies on `ReferenceError` as it loads, which crash-looped this sidecar on 2026-10-16.
  Errors in test files do not count: the sidecar never loads one, and the watcher does not judge
  their saves, so a hold on one could never be lifted by fixing it (held from 21:57 to 22:04 on
  2026-10-17, until an unrelated save arrived).
  Code that typechecks and still throws while loading gets through, and leaves nothing serving
  until the next save.
  Under `auto` it also waits until the sidecar's tree AND the panel's have been quiet for 3s
  (`AGENT_FEED_SUPERVISOR_QUIET_MS`) and no panel file is half-written, which the panel's dev
  server reports through `supervisor/supervisorBoard.ts` on the registry board (a peer cannot see
  it, and gets the quiet window alone). The panel does not wait in return: holding its updates
  while a sidecar change was pending, then reloading every page, was tried on 2026-10-14 and with
  several agents at work reloaded the canvas more often than it saved it. It watches `src/` and `agent-feed/wire/` with one
  recursive watch each (`watchTree`, 3 descriptors) rather than chokidar's per-file watches (514),
  the shape the catalog moved to when per-file watches went late. It replaced `bun --watch src/server.ts`,
  which re-read on every write: a write is a moment inside an edit, and a reload that threw left the
  process alive with its port free, killing every stream the panel held while nothing noticed for a
  minute. It once dropped typechecking, because a resident `tsc --watch` cost 844MB at its peak
  here (`footprint`, 2026-09-15); TypeScript 7 checks in a child that exits, a second and a few
  hundred MB only while it runs, which is what brought it back on 2026-10-16. The Justfile
  resolves `bun` to an absolute path and passes it with the entry (`AGENTDESK_BUN_PATH`,
  `AGENTDESK_AGENT_FEED_SIDECAR_ENTRY`), because the host's child environment is deliberately
  stripped of the PATH that would find a Homebrew install. Every fallback -- no `bun`, unreadable
  entry, non-executable `bun` -- serves the bundled binary and **logs why**, since silently serving
  the frozen one is indistinguishable from an edit that did nothing.
- **The supervisor runs a second child, the audio process** (`audio/audioServer.ts`, loopback, the
  sidecar's port plus one: 7683 beside 7682, 7783 beside 7782). It holds the audio channel's
  listeners, and is replaced only when a file in ITS import graph changes, or
  `agent-feed/wire/audioChannel.ts`: a save anywhere else replaces the sidecar and leaves a listener's
  stream playing. The panel's dev server sends `/api/audio/*` to it directly rather than through the
  sidecar, which would put the sidecar back in the stream's path; the sidecar forwards the same
  paths for agents that call it (`audio/audioForward.ts`). It stops when the supervisor leaves, and
  the launch recipes reclaim its port beside the sidecar's.
- **The supervisor replaces ITSELF when its own source moves**, by leaving: the host restarts it on
  termination within about a second, and a peer's watcher checks after every ship. Every other way
  of doing it either abandons the running sidecar or races the parent into two supervisors on one
  port. Which files count as its own are computed from its import graph (`supervisorSources.ts`),
  not listed, because a list goes stale silently and the code most likely to be wrong about whether
  it is current is the code that decides when to restart.
- **A restart can be held back, from the panel's Profile menu.** One switch covers this and the
  panel's own HMR, because "stop changing under me" is one thought; the parse gate is unchanged
  either way. Taking what is held is NOT one switch: the menu's Apply reloads the panel only, and
  Restart sidecars restarts every held machine together. They used to be one button, so taking a
  panel change restarted every sidecar under every surface, and read as the sidecar moving on its
  own. A
  supervisor has no port, so the command goes `POST /api/supervisor` on the sidecar,
  which leaves it on the same rendezvous board the supervisor publishes its state to
  (`<registry>/<user>.supervisor.request.json`), re-read both on a one-second timer and at the
  moment a change is judged -- the timer alone lost a mode chosen a second before a save. A starting
  supervisor clears that file, so a fresh one is always on auto and the dev server re-sends the
  reader's mode to any machine that disagrees with it.
- `just` arguments are POSITIONAL: `just host-run stable live bundled`, not `sidecar=bundled`, which
  would land in `variant`.
- Two hosts can run concurrently, stable and `.dev`, on tier-derived ports so they never collide:
  sidecar 7682/7782, signaling 41888/41988, offer 41890/41990. Each is env-overridable. Identity is
  the bundle id, not a flag: logs, keychain, launchd registration and Application Support directory
  all derive from it, and the kill-before-relaunch step matches the variant's exact installed
  executable rather than a bare `pkill -f AgentDeskHost`, which would kill both. The ids are
  `AGENTDESK_BUNDLE_PREFIX` plus a fixed name, from `.env` (a placeholder without it), and the
  signing is `AGENTDESK_APPLE_TEAM_ID`'s, or ad-hoc without one; a team with the placeholder prefix
  stops every recipe until the prefix is set. `.env.example` has both.

### A restart used to hand this Mac back the SHIPPED configuration

Settled 2026-09-10, after an evening spent on an IDE that was not broken.

`live` is a property of how the host was **launched**, not of the tree. The two variables that
choose it (`AGENTDESK_BUN_PATH`, `AGENTDESK_AGENT_FEED_SIDECAR_ENTRY`) reach the host only from the
process that launched it, so a host started any other way runs the frozen binary -- and launchd is
the other way. `LaunchAgentInstaller` registers the app with `RunAtLoad` and no environment, so
every reboot started the bundled sidecar and no dev server at all.

It fails silently by construction. Three of the four paths into the bundled arm log a reason, but
the first one does not, because an absent entry variable is not a fallback, it is the shipping path:

```swift
guard let entry = value("AGENTDESK_AGENT_FEED_SIDECAR_ENTRY") else { return bundled }
```

What that looked like: a sidecar compiled before the workspace routes existed, answering
`404 not found` in `text/plain` to every `/api/workspace/*` call, so the IDE surface rendered
perfectly and reported "the sidecar answered 404 with no JSON". Every probe aimed at the panel found
a healthy layer. The only record anywhere on the machine was one `reloadsOnEdit=false` line.

So **this Mac's login launch belongs to the dev path**, installed once with `just dev-login-install`
and reversed with `just dev-login-uninstall`:

- **`<host bundle id>.devlogin`** runs `tools/dev-login.sh` -> `just host-login`, which is
  `host-run`'s launch half with no build in it. A login that compiles is a login that can fail to
  produce a host at all.
- **`<host bundle id>.paneldev`** runs the Vite dev server in the foreground, `KeepAlive`.
  It is a separate job rather than a child of the first because **launchd reaps a job's process
  group when the job exits**: measured, `agent-webview-dev-ensure` reported "serving at" from
  inside the login job and the port was empty seconds later. A server that must outlive its starter
  has to BE a job -- which is also how it earns a restart when Vite dies at 3am.
- **`<host bundle id>.remotesidecars`** runs `tools/remote-sidecar-login.sh` -> `just
  remote-sidecar-watch-all`, `KeepAlive`, a separate job for the same reason the panel's is. It
  reads the peers from `AGENTDESK_PANEL_REMOTE_SIDECARS` in `.env` -- the same string the panel
  resolves peers from -- and for each one keeps its sidecar RUNNING and its sources CURRENT.
  Neither half is worth anything alone: shipping into a dead sidecar and supervising a two-day-old
  tree are the same failure. This is the remote instance of the frozen-runtime bug above. A peer's
  sidecar runs under the same supervisor the Mac's does, so it picks up its sources seconds after
  they change -- but they only changed when somebody ran `ship`, and nobody did. Measured
  2026-09-13 on the oracle peer: up two days and four hours, newest shipped file two days old,
  answering `/api/config` the whole time. **A peer that answers tells you nothing about which code
  it is answering from**, which is why `remote-sidecar-status` now says so out loud. With no peers
  declared the job says so and idles, so installing it before there is a peer is harmless.
- **`<host bundle id>.proxyobserver`** runs `tools/proxy-observer-relay-login.sh` -> `just
  proxy-observer-relay`, `KeepAlive`, and it is the peers job's other half. A peer's sidecar mirrors
  Claude's live network traffic by subscribing to proxy-agent's observer API, which listens on THIS
  Mac's loopback and refuses anything whose `Host` is not a literal loopback address -- deliberate
  DNS-rebinding hardening, and `tailscale serve` cannot satisfy it in either mode. The relay sits in
  front of it on 9156, rewrites `Host`, and is a local caller as far as proxy-agent is concerned.
  **Read that as a deliberate widening, not plumbing**: what crosses the tailnet is captured
  Anthropic API traffic, prompts and responses included, bounded by WireGuard device identity and by
  nothing else, on the peer as well, where any local process can connect. Without the relay a peer
  points at its own loopback, finds nothing, and shows no mirror -- which looks exactly like a peer
  whose sessions are quiet, so nothing reports it.
- The app's own agent is booted out and deleted by the install, because two `RunAtLoad` jobs have no
  defined order and the loser is whichever host `open` then merely activates. It stays gone: every
  launch this path makes carries `AGENTDESK_DEV_ITERATION_RUN`, which is the flag
  `applicationDidFinishLaunching` checks before registering it.
- `AGENTDESK_AUTO_APPROVE` is **not** set by the login path, though `host-run` sets it. Nobody is
  watching a launch that happens at login, and a pairing request that approves itself on an
  unattended Mac is a different thing from one approved in front of you.
- `host-login` reclaims the sidecar ports first. A sidecar outlives a host that was killed rather
  than asked to quit, and it keeps the port; the new host's sidecar then cannot bind and the machine
  serves the dead host's. Measured while building this: an orphaned bundled sidecar held 7682 while
  `bun --watch` ran beside it, and `/api/workspace/list` answered 404 with both of them up.

`just host-run` is still the iteration command and still the stop-and-wait checkpoint. The login
path only starts what is already installed, so **an installed app moves forward only when you run
`host-run`**.

### Where the dev server listens, and why the phone's origin is HTTPS over the tailnet

The dev server listens only as far as `AGENTDESK_PANEL_LISTEN` reaches (`listenAddresses.ts`), because
the panel has no login and drives this Mac, so where it can be reached from is its boundary:
`loopback` (the default; this Mac only, `http://127.0.0.1:5173`), `tailnet` (this Mac's tailnet
address and loopback), or `network` (every network, plain http, for a phone without Tailscale on a
network you trust). `just agent-webview-dev-origin` is the one place a mode becomes an origin. Until
2026-10-23 it listened on every interface and a pf rule turned the local network away; the rule
covered IPv4 alone, so the Wi-Fi reached it over IPv6, and the rule was removed with the binding fix.

A phone needs `tailnet` mode. Its origin is `https://<this-mac>.<tailnet>.ts.net:5173`, derived per
machine by `tools/tailnet-dns-name.sh` and never written down. One origin serves every surface there
because TLS is a property of the port. `just agent-webview-dev` is the same server in the foreground for watching its
log; `agent-webview-dev-cert` issues or renews the certificate; `agent-webview-dev-stop` frees the
port; `agent-webview-dev-status` is the only check that exercises the browser leg, and it checks the
**protocol**, not just the status code.

**A plain browser tab at that origin needs no credential, and that is deliberate.** The sidecar API
has no authentication of any kind: it reads no `Authorization` header and has no 401 path, so a
request with no header and one with a bogus bearer both answer 200. What stands in for auth is the
bind address -- `AGENT_FEED_HOST` defaults to `127.0.0.1`, and a sidecar reached over the tailnet is
authenticated and encrypted at the device level by WireGuard, which is the guarantee loopback was a
proxy for. **Do not reintroduce a token without also making the sidecar check one.** The previous
scheme minted one per dev-server start, wrote it 0600 under the runtime root, had the host send it
as a bearer on every request, and was validated by nobody, so it was removed rather than left
looking like protection.

**The bind address keeps out other machines, not the owner's own browser.** A browser does not
treat loopback as a boundary: any page open in it can send the sidecar requests (a `text/plain`
POST needs no preflight, and the routes parse JSON whatever the Content-Type says), and a page
whose name is re-pointed at 127.0.0.1 (DNS rebinding) can read every answer, session ids
included, and then type into a session. So `http/requestGuard.ts` runs ahead of every route and
refuses a `Host` outside `config.allowedHosts` (loopback, the bind address, and
`AGENT_FEED_ALLOWED_HOSTS`) and any request whose `Sec-Fetch-Site` is `cross-site` or
`same-site`; its test sends both over a real socket. The panel's proxy passes because it rewrites
`Host` to the sidecar's own authority, and the host's clients send no `Sec-Fetch-Site`. A new way
of reaching the sidecar is a new `allowedHosts` entry, never a removed check.

During an approved host launch, `agent-webview-dev-ensure` reuses a healthy server in the mode asked
for (it asks the server, at `/@agentdesk/listen-mode`), with intact TLS where the mode has it, or
stops the configured port's listener before recreating it; a failed stop or readiness check
aborts the launch. One server means one `/api` target, so a browser tab follows whichever host tier
started it.

## Runtimes come from mise

Since 2026-10-25 Node, npm and Bun come from mise and nothing else (ADR-0157): no nvm, no Homebrew
Bun. The repository root's `mise.toml` pins exact versions; mise's global config tracks Node LTS and
the latest Bun for everything without a pin. Every caller reaches them through mise's shims,
`~/.local/share/mise/shims`, which come first on the owner's shell PATH, on the PATH
`just dev-login-install` writes into the login jobs, and on tmux's global PATH, where
`AGENTDESK_BUN_PATH` points at the shim for new sessions.

- **The host runs the pinned Bun.** The launch recipes ask Bun, from this tree, for its own
  `process.execPath`, so `AGENTDESK_BUN_PATH` is `~/.local/share/mise/installs/bun/<pin>/bin/bun`.
  Through the shim alone, the host's working directory is outside the tree and would get the global
  version instead.
- **Upgrading:** `mise upgrade --bump` in the repository root, `just check-legs` on the new
  versions, commit `mise.toml`, then restart the dev loop (quit the host, then
  `launchctl kickstart -k gui/$(id -u)/<host bundle id>.devlogin`) so the host takes the new path.
  The shims directory does not move, so the login jobs need no re-install.
- **A Claude Code session keeps the PATH it started with.** One started before a runtime moved finds
  the old one, or none, in its shell until it restarts.

## The dev origin serves HTTP/2, and it is load-bearing

Settled 2026-09-06, after an evening spent debugging three features that were not broken. Only
`tailnet` mode has TLS, so only it has HTTP/2: the plain-http modes are HTTP/1.1, where the limit
below applies by design, and `agent-webview-dev-status` says so rather than calling it a fault.

`server.https` gives the panel's dev origin TLS **and HTTP/2** -- but Vite downgrades it to
TLS-only "if the `server.proxy` option is also configured" (its own server-options doc). Under
HTTP/1.1 a browser allows about **six connections per origin**, and this panel holds an EventSource
for the session catalog, the transcript, background tasks, the summary, usage, bots, the session
board and the terminals. More streams than connections.

The stream that loses is whichever the page asks for last, which is the terminals stream, because
nothing opens it until a terminal does. It then fails in the worst available way: **silently**. No
error, no console line, no frame. The screen replay waits on its `onopen`, so the terminal paints
nothing and its footer says `Opening terminal` -- which is true, and stays true forever. Keystrokes
reach tmux and are echoed the whole time; the echo has nowhere to arrive. It is intermittent,
because which stream loses depends on what the page opened first.

So:

- **`/api` is proxied by the `panelSessions` plugin's middleware, not by `server.proxy`.** Adding a
  `server.proxy` entry silently costs the whole origin its HTTP/2. If you need a new proxied path,
  add it to that middleware.
- **Compression and source maps are a middleware too**, `app/dev-server/slimResponses.ts`, first in
  the plugin list. Vite appends every module's source map to the module as base64 and compresses
  nothing, so a cold load on the phone was 37MB, 26MB of it maps, and took 40.8s (2026-10-17). It
  moves each map to `/@panel-source-map` (fetched only when developer tools open) and compresses
  the rest; the same load is now about 2.7MB. It steps aside for `/api`, `/session/` and anything
  written in pieces, because a compressor holds bytes back and would stall an event stream.
- **A proxy on an HTTP/2 origin must strip hop-by-hop headers in both directions.** `connection:
  keep-alive` from the sidecar's SSE throws `ERR_HTTP2_INVALID_CONNECTION_HEADERS` on the way out,
  and an HTTP/2 request arrives with its pseudo-headers (`:method`, `:path`, `:scheme`,
  `:authority`) in the same map as the ordinary ones, which Node's HTTP/1.1 client rejects with
  "Header name must be a valid HTTP token". Both were measured the first time this origin
  negotiated h2.
- **`just agent-webview-dev-status` checks the protocol**, not just the status code, and fails
  loudly on a downgrade. Run it before concluding a panel surface is broken.

The general lesson is the one already written under "An absent result is a claim about the probe" (`docs/agents/debugging.md`):
what was absent here was a **connection**, and every probe aimed at the feature found a healthy
layer -- `POST /input` answered 204, the PTY daemon echoed input on a hand-driven socket, tmux held
the bytes. All true, all pointing away from a transport that had never connected. When a surface is
blank rather than wrong, **ask whether its stream ever opened** before reading its code.

## Durable runtime and disposable builds

- `.build` is compilation output, not the home of a deployed host, helper, or live panel
  credentials. `tools/runtime-paths.mjs` resolves the durable root, defaulting to
  `~/Library/Application Support/AgentDeskRuntime` with an absolute `AGENTDESK_RUNTIME_ROOT`
  override. Host apps live at `hosts/<bundle-id>/AgentDeskHost.app`, the standalone capture helper
  at `bin/grid-encoder`, and the panel's TLS files under `agent-panel/`.
- For a helper update use `just grid-encoder-install`. It builds and atomically installs without
  rebuilding, reinstalling, or relaunching either app. **The agent session's helper is not in that
  account's runtime root.** Its sidecar sets `AGENT_FEED_GRID_ENCODER_PATH` to a shared location,
  because `~/Library` is 0700 and the console user cannot otherwise reach it, so update it with
  `just grid-encoder-install /Users/Shared/grid-encoder` and check `ps` for the path the resident
  helper actually runs from before believing an install took. Installing to the account's own root
  instead succeeds, reports a path, and leaves the running helper untouched. That account can run
  the install itself: `tools/install-node.sh` puts a pinned, checksum-verified node in its
  `~/.local`, which is what `install-grid-encoder.sh` needs and what the agent account was missing.
  `sh tools/build-grid-encoder.sh` and `just check` only compile candidates. A missing helper reports
  the install command and has no build-directory fallback.
- Do not run cache deletion while builds or tests are active. Moving the runtime does not authorize
  deleting caches, resetting TCC, replacing credentials for a running server, or relaunching a
  daily-driver app. See ADR-0113 for the deployment boundary.

## Native code canaries

Moved from the root `AGENTS.md` "Code" list on 2026-10-17, because they matter only when the Swift or
the PTY runtime changes.

- Standalone `＋ IDE`, `＋ Agents`, and `＋ Terminal` windows are independent UUID-backed instances. Persist each open instance's frame and Desktop assignment, remove only a user-closed instance, preserve all open descriptors during host termination, and restore them without activation or any move-to-active-Space fallback. Exact Space movement, display-local ordinal repair, capture, and verification belong to the shared Desktop window-placement authority (ADR-0092), not per-feature copies.
- `SpacesProvider`'s smoke test runs against the live SkyLight binding and is the canary for private-API surface drift across macOS versions. Run it when a macOS update lands.
- `just pty-handover-cross-version [base-ref]` is the canary for PTY runtime wire drift, and the only handover test that is not talking to itself. Every in-process handover test builds both peers from one tree, so it agrees with itself no matter what the wire does; this one builds the runtime from an older commit and asserts the current binaries can still take its live session over (ADR-0080). **Run it after any change to `terminal/pty-manager/proto/` or the handover code**, passing the commit before the change as the base. It is not in `just check` because it cold-builds an older tree.
