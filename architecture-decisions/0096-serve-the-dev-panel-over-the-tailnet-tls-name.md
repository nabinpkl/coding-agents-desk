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
one, for the same TSX file. This touches `packages/AgentPanel/Web/vite.config.ts`, the launch
recipes in `Justfile`, and nothing in Swift.

## Decision Drivers

- The phone must pick up a panel edit without a client rebuild, install, or re-pair.
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

The origin reaches the client as an environment variable through `devicectl`, which is also the
safety property and not merely the mechanism: a client launched from the home screen or installed
by TestFlight has no environment to read, so the daily driver always runs its own bundled build. No
Swift changed for any of this. `AgentPanelWebViewController` already read the variable, and the
panel already chooses its transport by whether a native message handler is present rather than by
its own origin, so a phone loading from Vite still reaches the sidecar through the host's relay and
the token still never enters the page.

### Consequences

- Good, because one edit to one TSX file now reaches the Mac panel and the phone panel at once,
  with no build, no install, and no re-pair on either.
- Good, because the client's Info.plist stays free of ATS keys, and the thing that keeps the daily
  driver safe is the absence of an environment rather than the correctness of a variant check.
- Good, because there is one dev origin, so "which code is the panel running" has one answer on
  both surfaces.
- Bad, because a live-panel launch now depends on tailscaled being up and MagicDNS resolving, where
  the Mac leg previously needed only loopback. A launch that cannot reach the dev server fails
  rather than falling back, so this is visible rather than silent.
- Bad, because the MagicDNS name enters public Certificate Transparency logs, as any publicly
  trusted certificate does. The name was already registered in Tailscale's DNS.
- Neutral, because the certificate expires. `--min-validity 168h` re-issues on the launch that
  first sees less than a week left, so renewal is a consequence of running, not a chore.
- Neutral, because a phone launched with the live origin and a phone launched from the home screen
  now render the panel from different code. That difference is the safety property, but it does
  mean "it works on my phone" needs to say which launch.

### Confirmation

`tools/host-run-lifecycle-tests.sh` (in `just check`) asserts that both host launches and both
iPhone launches choose the live panel by default, and that `panel=bundled` leaves the origin unset.
A default that silently reverted would break nothing visible -- every surface would still launch and
still render a panel, just not the code being edited.

The felt confirmation is the acceptance test: edit a TSX file, and watch it change in the Mac
window and on the phone without either being rebuilt.

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
