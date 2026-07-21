---
status: accepted
date: 2026-07-21
supersedes: ADR-0063
---

# Project the full Chrome hierarchy to iOS

## Context and Problem Statement

ADR-0063 deliberately stopped Chrome window and tab metadata at the local macOS projection while the
iPhone continued receiving only the selected page. That split made the two Browser surfaces behave
differently even though both already embed the same `BrowserProjection` WebKit package. The iPhone now
needs the same outer window strip, inner tab strip, read-only toolbar, status states, and selection
semantics as the macOS projection.

## Decision Drivers

- Keep one shared browser renderer and one set of window, tab, generation, and accessibility semantics.
- Preserve the one-recorder model and source-side stale-generation fencing from ADR-0063.
- Make an iPhone window selection projection-only and an iPhone tab selection activate Chrome without
  focusing its window.
- Seed a newly attached or reattached iPhone with enough state to render the shell before live batches.
- Reject older clients cleanly instead of letting an unknown metadata frame silently stop the DOM lane.
- Keep password values source-masked and avoid logging projection payload content.

## Considered Options

- Keep iOS page-only and maintain separate renderer modes.
- Add an optional compatibility flag so protocol-11 clients ignore browser metadata.
- Carry the full projection contract on the existing authenticated DOM stream and require protocol 12.

## Decision Outcome

Choose the existing authenticated DOM stream as the bidirectional full-projection lane and raise the
AgentDesk session protocol to 12. The host stores the latest validated `browser-state` alongside the
rrweb checkout buffer. A remote late join receives `projection-host`, `browser-state`, the buffered
page checkout and increments, then `dom-status`. Live browser-state snapshots fan only to authenticated
remote DOM lanes; the macOS in-process projection continues receiving its validated state directly.

The iOS client accepts validated `browser-state` and `projection-host` frames in addition to
`dom-batch` and `dom-status`, and delivers them unchanged to the same `BrowserProjection` webview used
on macOS. The webview always renders its nested browser shell. Window and tab selections travel back on
the existing serialized DOM stream as `browser-select-window` and `browser-select-tab`; the host
forwards them through the authenticated native bridge, where the extension remains authoritative for
generation freshness, window membership, tab membership, and focus behavior.

Protocol 12 is intentionally incompatible with protocol 11. A protocol-11 iOS client treats the new
metadata frames as unknown and would stop its DOM receive loop, so advertising compatibility would be
false. Host and client must upgrade together and reject older peers during session establishment.

The iOS native Browser status and emulation bar remains outside the shared webview. This decision makes
the web content beneath it exact across platforms; changing that native diagnostic shell is a separate
UI decision.

### Consequences

- Good, because macOS and iOS now render the same complete Chrome hierarchy from the same package.
- Good, because direct Chrome changes and AgentDesk-originated selections retain one authoritative
  extension state machine and one recorder.
- Good, because reconnects reconstruct metadata and the current page without waiting for a new Chrome
  event or leaking a previous generation.
- Bad, because host and client builds below protocol 12 cannot establish a session with this build.
- Bad, because complete Chrome titles, URLs, groups, and bounded favicons now use session bandwidth.
- Neutral, because browser metadata remains inside authenticated local or QUIC transport and is not
  exposed to the Agent feed, Files lane, terminal lane, or logs.

### Confirmation

Wire tests pin protocol 12. Relay tests pin remote-only metadata fanout and late-join ordering. Client
tests pin metadata validation and browser-selection command routing. The shared renderer verification
requires the nested shell at startup. Host and client builds, `just browser-projection-verify`, and the
repository check gate must remain green.

## Links

- SPEC, Chrome Projection
- ADR-0063, one-recorder multi-window projection and generation model
- ADR-0030, authenticated QUIC role streams
- ADR-0047, serialized client-to-host DOM control writes
