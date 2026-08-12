---
status: accepted
date: 2026-08-11
---

# Relay the agent feed instead of restating it in Swift

## Context and Problem Statement

The agent feed's data model was written out four times: the sidecar stated it in TypeScript,
`host/AgentDeskHost/AgentFeedSidecarClient.swift` restated it in long keys to call the sidecar's
REST API, `packages/AgentDeskWire/Sources/AgentDeskWire/AgentFeed.swift` restated it again in
abbreviated keys for the QUIC lane, and `AgentFeedBridge` renamed one into the other. Roughly 2,100
lines of Swift existed only to describe shape, alongside 13 hardcoded sidecar paths. Adding a field
edited all four, and every per-side test stayed green on both sides of each drift, which is the
repo's own recorded cause of silent wire breakage.

Separately, the panel's assets were resolved only from `Bundle.module`, so shipping an edited TSX
file meant a Vite build, a resource publish, an `xcodebuild`, and a relaunch. Between the two, no
agent-feed change of any kind could be made without compiling Swift.

## Decision Drivers

- One authoritative home per fact. Four restatements of one model is four places to drift.
- The iteration loop for feed behaviour, wire shape, and UI should be TS/TSX only, with HMR.
- The sidecar's control token is a capability: the host mints it per spawn
  (`AgentFeedSidecarProcess.swift`) and the sidecar deletes it from its own environment so
  model-authored bash cannot reach the control API. Nothing may hand it to a page that renders
  agent-authored markdown.
- Native authority (writing into another application's text fields through Accessibility, owning a
  PTY, speaking) must stay bounded and reviewable. Widening the relay must not widen that.
- The relay must not become an open local proxy.

## Considered Options

- **Option A**: Keep the typed protocol; generate the Swift mirrors from the TS types.
- **Option B**: Give the panel the sidecar's origin and token and let it `fetch` directly.
- **Option C**: Relay opaque HTTP through Swift, split from native authority by tag prefix.

## Decision Outcome

Chose **Option C**. Option B is disqualified outright by the capability driver: the token exists
precisely so that a compromised or prompt-injected agent cannot reach the control API, and the
panel renders agent-authored markdown, so putting the token in the page undoes the property the
token was created for. Option A satisfies the drift driver but not the loop driver, since generated
mirrors still compile: a new field would still be a Swift build, and a generator is one more thing
to keep in step. Option C is the only one that removes the restatement AND the compile, because a
relay that copies bytes has nothing to regenerate.

Three owners, no overlap:

- **Sidecar (TS)** owns the model, the endpoints, and multi-step orchestration.
- **Panel (TSX)** owns the view and its data source.
- **Swift** owns transport and native authority, and never names a payload field.

Two protocols share the `.agent` QUIC lane and the `agentFeed` postMessage channel, split by tag
prefix:

| Tags | Nature |
|---|---|
| `agent-http-*` | Generic request/response relay. Opaque in both directions. |
| `agent-window-*`, `agent-terminal-*`, `agent-say` | Native authority. Stays typed and bounded. |

The envelope is six frames (`req`, `cancel`, `head`, `chunk`, `end`, `err`), defined once in
`AgentFeedRelayFrames.swift`. `AgentFeedHTTPRelay` validates the path against a narrow allow-list
(`/api/` prefix, no traversal, no scheme or authority, GET/POST only, capped body), attaches the
bearer header, and streams the response back chunked and interleaved by `rid`.

Orchestration moved to the sidecar rather than being relayed piecemeal. Opening a thread used to be
four coordinated requests made by whoever held the connection -- probe the page count, fetch the
tail window, follow the durable stream from that window's sequence, and open live-tail and
extension-UI streams when capabilities warranted -- with generation counters guarding against a
subscription the viewer had already left. All of that is the sidecar's own knowledge (its window
size, its sequence numbering, its capability table), so it is now one endpoint,
`GET /api/sessions/{source}/{sessionId}/timeline?mode=`, and a subscriber opens one stream.

For the second half of the problem, `WebPanelWebViewController` gained a `developmentOrigin`
parameter that loads the panel from a URL and installs no scheme handler, and
`AgentPanelWebViewController` owns the policy: `AGENTDESK_AGENT_PANEL_ORIGIN`, http(s) only,
throwing on anything else. It is not a fallback -- with the override set the bundled tree is not
consulted at all, so a dev server that is down fails to load rather than quietly serving stale code.

### Consequences

- Good, because a new feed field is a sidecar change and a panel change, and nothing between them
  rebuilds. The four restatements are one.
- Good, because ~2,100 lines of shape-only Swift and 13 hardcoded endpoints are deleted;
  `AgentFeedBridge` (852 lines) became a ~150-line relay.
- Good, because the panel serves from Vite with HMR, so a TSX edit lands without a Swift compile.
  This is the default rather than a setup step: `host-run` and `host-run-dev` start the dev server
  if it is not up, wait for it to answer, and point the launched host at it. A loop nobody has to
  remember to turn on is the only kind that survives, and the alternative -- an origin exported by
  hand -- fails in the direction that looks like success, a host quietly running the bundled build
  while you edit source that reaches nothing. The launch refuses to proceed if the server cannot
  come up, for the same reason the override itself is not a fallback.
- Bad, because one ordered lane now carries both feed updates and large raw-event bodies, so a big
  transfer can delay feed latency. Interleaving by `rid` and a 1MB chunk bound are the mitigation;
  this is the risk to measure first if the feed feels slow under a large fetch.
- Bad, because the typed bridge implicitly bounded what it sent and a byte relay does not. A fast
  stream over a slow tailnet link needs an explicit bound, which is not yet in place.
- Bad, because long keys cost roughly 30-40% of key overhead on event-heavy payloads. Accepted;
  compressing at the relay is a later one-time Swift change if it measures badly.
- Neutral, because the client's downstream path was already field-agnostic: `deliverAgentPush`
  forwards `agent-*` frames verbatim by prefix, and `agent-http-*` is not in
  `nativeInterceptedTypes`, so no client change was needed.
- Neutral, because the HMR loop was Mac-only at first: the same controller runs on the phone, but
  loading `http://<tailnet-ip>:5173` there is refused by App Transport Security
  (`NSAllowsLocalNetworking` does not cover a tailnet address), and the client ships to a daily
  driver through TestFlight, where an ATS hole opened for dev convenience is the kind that survives
  into release. ADR-0096 extends the loop to the phone without one, by serving the dev origin over
  TLS under a Tailscale-issued certificate for the MagicDNS name.
- Neutral, because the host still names one sidecar path. The terminal handoff asks whether a
  session is live before taking its PTY over, which is a capability decision rather than a view of
  the feed, so it keeps a typed call.

### Confirmation

`just agent-feed-fitness` (in `just check`) fails if `AgentFeedBridge.swift` returns, if any of the
named feed payload types reappears in Swift, if the host names more than one sidecar path, or if a
panel request tag is neither the relay nor a native capability.

`agent-feed/wire/contract-fixture.json` is one document read by two suites --
`agent-feed/sidecar/src/http/contractFixture.test.ts` asserts the routes emit exactly those bodies,
`packages/AgentPanel/Web/src/features/activity-feed/data-source/contractFixture.test.ts` asserts the
data source parses them into what the view renders. One fixture, not two, because per-side fixtures
are what hid the last drift.

`tools/host-run-lifecycle-tests.sh` (in `just check`) asserts the live panel is what both host
launches choose by default, and that `panel=bundled` leaves the origin unset. A default that
silently reverted would break nothing visible -- the host would launch and the panel would load,
just not the code being edited.

The felt confirmation is the acceptance test for the whole change: edit a TSX file and see it change
in the running host with no rebuild.

## Links

- ADR-0086 two views of the agent feed, with raw as the guarantee
- ADR-0091 own live agent sessions behind provider backends
- `agent-feed/wire/README.md` the one definition of the wire contract
