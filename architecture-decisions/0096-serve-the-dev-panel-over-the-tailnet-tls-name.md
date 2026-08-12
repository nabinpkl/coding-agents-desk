---
status: accepted
date: 2026-08-11
---

# Serve the dev panel over the tailnet's TLS name, so the phone gets HMR too

## Context and Problem Statement

ADR-0095 gave the Agent Panel a Vite dev origin, and left the phone out of it: the iPhone client
would have to load `http://<tailnet-ip>:5173`, App Transport Security refuses cleartext to a
tailnet address (`NSAllowsLocalNetworking` does not cover 100.64/10), and the client ships to a
daily driver through TestFlight, where an ATS exception opened for dev convenience is the kind that
survives into release. So the Mac got a no-rebuild loop and the phone kept a rebuild-and-reinstall
one, for the same TSX file. And the phone's loop has a requirement the Mac's does not: it must hold
across an app close and reopen, and it must work on a client installed from TestFlight, not only on
a cabled dev build. This touches `packages/AgentPanel/Web/vite.config.ts`, the launch recipes in
`Justfile`, the agent lane on both sides, and `WebPanelWebViewController`.

## Decision Drivers

- The phone must pick up a panel edit without a client rebuild, install, or re-pair.
- It must hold across an app close and reopen, and it must work on a TestFlight install, which is
  how the daily driver gets the client. Release governs the compiled Swift, not the runtime TS.
- No ATS exception in the client. The stable client is a daily driver installed from TestFlight.
- The sidecar's control token stays out of the page, which is why the relay exists at all
  (ADR-0095); where the page's CODE comes from must not change where its DATA comes from.
- A dev-only affordance must not be reachable by the shipped app on the daily driver.

## Considered Options

- **Dev-only ATS exception**: an `NSAllowsArbitraryLoads` or per-domain exception in the client,
  scoped to the `.dev` bundle id.
- **Self-signed certificate the phone trusts**: install a dev CA profile on the device.
- **Tailscale-issued certificate for the MagicDNS name**: serve Vite over TLS as
  `https://<machine>.<tailnet>.ts.net:5173`.

## Decision Outcome

Chose **the Tailscale-issued certificate**, because it is the only option that satisfies the
no-exception driver instead of working around it: `tailscale cert` gets a publicly trusted Let's
Encrypt certificate for the MagicDNS name, so the load is an ordinary https load and default ATS is
already satisfied. The dev-only ATS exception was knocked out by the daily-driver driver -- scoping
it to the `.dev` bundle requires a second Info.plist whose only content is the hole, and the reason
to have it never stops applying to the stable build. The self-signed CA was knocked out by the same
driver from the other side: a trusted-root profile on the phone is a broader grant than the app,
and it outlives the dev session that wanted it.

There is ONE origin, not one per surface. TLS is a property of the port, so a certificate loaded
for the phone ends http on that port for the Mac; rather than run two servers, both surfaces load
the same https name. The Mac pays a dependency on its own tailnet name resolving, which for a
product whose every other leg is the tailnet is not a new one.

**The origin reaches the client over the wire, pushed by the host on every agent-lane attach**, as
an `agent-panel-origin` frame carrying the origin string or nothing for the bundled build. The
first cut delivered it as an environment variable through `devicectl`, which fails the requirement
outright: a client installed by TestFlight or launched from the home screen has no environment, and
those are exactly the launches that have to work. Nothing device-local can replace it either, since
there would be nothing to seed the device-local copy from.

Restating it per attach is also why the phone survives a close and reopen without remembering
anything. There is no persisted origin to go stale, and no way for the phone and the Mac to
disagree about which code is live: the host that serves the panel is the host that says where it
is, and a phone that reconnects to a host launched without a live panel is told so and returns to
the bundled build.

The client applies a stricter rule than the Mac and refuses any origin that is not `https`. ATS
would refuse a cleartext load anyway; refusing it in our own code turns a webview that silently
never loads into one logged line. Swift changed only to move and apply the value:
`AgentPanelWebViewController` gained a runtime `loadPanel(origin:)` where it previously chose once
at init. The panel already chooses its transport by whether a native message handler is present
rather than by its own origin, so a phone loading from Vite still reaches the sidecar through the
host's relay and the token still never enters the page.

This reverses one line of ADR-0095: the bundled tree IS consulted on a dev-origin build now, and
its scheme handler is always installed, because `WKWebViewConfiguration.setURLSchemeHandler` can
only be set before the webview exists and switching back to bundled has nowhere to go without it.

### Consequences

- Good, because one edit to one TSX file now reaches the Mac panel and the phone panel at once,
  with no build, no install, and no re-pair on either.
- Good, because the client's Info.plist stays free of ATS keys, and the client refuses a non-https
  origin itself rather than relying on ATS to refuse it silently.
- Good, because there is one dev origin, so "which code is the panel running" has one answer on
  both surfaces.
- Bad, because a live-panel launch now depends on tailscaled being up and MagicDNS resolving, where
  the Mac leg previously needed only loopback. A launch that cannot reach the dev server fails
  rather than falling back, so this is visible rather than silent.
- Bad, because the MagicDNS name enters public Certificate Transparency logs, as any publicly
  trusted certificate does. The name was already registered in Tailscale's DNS.
- Neutral, because the certificate expires. `--min-validity 168h` re-issues on the launch that
  first sees less than a week left, so renewal is a consequence of running, not a chore.
- Bad, because the daily driver now takes panel code from its host by default, including the
  TestFlight install. That is the requirement, not an accident: the whole point is that the phone
  which has to work is the one nothing device-local can reach. The cost is that a `host-run` whose
  dev server dies mid-session leaves the phone's panel broken until the server is back, where a
  bundled panel would have kept working. The Mac's panel is broken in exactly the same way at the
  same moment, so it is visible rather than a phone-only mystery, and `panel=bundled` on the host
  opts both surfaces out.
- Neutral, because "which panel code is this" is now a property of the host, not of how the phone
  was launched. Two phones on one host always agree; the same phone on two hosts may not.
- Bad, because making a plain browser tab work at this origin inverts who owns the sidecar's
  control token. A browser has no relay to attach the bearer header, so the dev server's `/api`
  proxy attaches it, which requires the server and the sidecar to share one. The host cannot supply
  it -- it mints per spawn and holds the value in memory, deliberately unreachable -- and the server
  outlives every launch that reuses it, so the server mints into `0600
  .build/agent-panel-dev/control-token` and the host adopts it
  (`Config.agentFeedSidecarControlTokenOverride`). The cost is exactly the property the mint was
  protecting: while a dev server is up, anything running as this user can read that file and drive
  the control API. Accepted because it is confined to a dev server's lifetime and removed with it,
  and because the guarantee that actually bounds the blast radius is untouched -- the token still
  never enters the page, on any surface, so agent-authored markdown cannot reach it however the
  page was served.
- Bad, because that adoption is order-dependent in a way only one surface reports. A host launched
  before its dev server, or against a server left over from an older tree, mints its own token and
  the two disagree; the Mac webview and the phone keep working through the relay, and only a browser
  tab shows the failure, as an empty feed. `just agent-webview-dev-status` exists to answer that
  question directly, and the ensure step says so on stderr when it reuses a tokenless server.
- Neutral, because one dev server means one `/api` target, so a browser tab follows whichever host
  tier started the server. The webview and phone legs are unaffected: they reach their own host's
  sidecar through their own relay, which is why one page origin never meant one sidecar.

### Confirmation

`tools/host-run-lifecycle-tests.sh` (in `just check`) asserts that both host launches choose the
live panel by default, that `panel=bundled` leaves the origin unset, and -- the negative that
matters -- that neither iPhone launch carries the origin in its environment. A default that
silently reverted would break nothing visible; every surface would still launch and still render a
panel, just not the code being edited. Env delivery coming back would be worse than that: it works
perfectly on the cabled dev client an agent is most likely to test with, and does nothing at all
for the TestFlight install that motivated this.

The same file asserts the token wiring, for the same reason: that the dev server carries the token
its proxy attaches, that the file it writes is not world-readable, that both host launches adopt it
rather than minting, that stopping the server removes it, and that it survives `open`'s launchd
environment. Every one of those can break while the Mac and the phone keep working perfectly, so
none of them has a felt symptom to catch it.

The felt confirmation is the acceptance test: edit a TSX file, and watch it change in the Mac
window and on the phone without either being rebuilt -- then force-quit the phone app, open it from
the home screen, and see the edit still there.

## Pros and Cons of the Options

### Dev-only ATS exception

- Good, because it needs no certificate, no CA, and no name.
- Bad, because the exception lives in the shipped app's Info.plist, and the argument for keeping it
  scoped to `.dev` is a convention, not a mechanism.
- Bad, because it re-opens cleartext for the whole app rather than for one dev server.

### Self-signed certificate the phone trusts

- Good, because it needs no external CA and no public record.
- Bad, because trusting a dev root on the phone grants far more than loading one dev server, and
  nothing revokes it when the session ends.
- Bad, because it is per-device setup, repeated for every phone that ever tests the panel.

### Tailscale-issued certificate

- Good, because the connection is ordinary trusted TLS, so no client-side grant of any kind exists
  to be forgotten.
- Good, because issuance and renewal are one idempotent command against infrastructure the project
  already depends on.
- Bad, because it requires HTTPS certificates enabled for the tailnet, and publishes the machine
  name to Certificate Transparency.

## Links

- ADR-0095 relay the agent feed instead of restating it in Swift
- ADR-0038 mirror the page from the browser the human already uses
- `tools/tailnet-dns-name.sh` the one place the dev server's name is derived
