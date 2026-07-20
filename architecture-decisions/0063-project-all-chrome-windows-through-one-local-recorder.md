---
status: accepted
date: 2026-07-20
---

# Project all Chrome windows through one local recorder

## Context and Problem Statement

The Chrome extension and shared browser webview previously modeled one active page. That was enough to
prove isolated-world rrweb capture, the authenticated native bridge, and trusted input forwarding, but
it could not represent the browser the user actually works in. Multiple normal Chrome windows each have
their own ordered tabs, selected tab, groups, and focus state. Treating the focused page as the whole
browser also made an AgentDesk selection accidentally synonymous with bringing Chrome forward.

The local macOS test seam needs the complete browser hierarchy before that metadata is considered for
any remote surface. The existing iPhone Browser surface must keep receiving only the currently recorded
page in this iteration.

## Decision Drivers

- Represent every normal Chrome window and every tab without adding browser-management authority.
- Keep Chrome's actual focused window separate from AgentDesk's projected window.
- Guarantee that delayed output from a previous window, tab, or navigation cannot repaint the current page.
- Keep one isolated-world rrweb recorder and one optional debugger attachment.
- Keep browser metadata on the authenticated local Unix bridge and out of QUIC.
- Make the complete flow verifiable through stable accessibility identifiers and a throwaway Chrome profile.

## Considered Options

- Continue following only Chrome's focused window and selected tab.
- Record every tab concurrently and merge their streams in the host.
- Enumerate every normal window as metadata while recording only the projected window's selected tab.

## Decision Outcome

Choose one authoritative extension session containing enabled state, the actual focused normal window,
the AgentDesk-projected window, stable session-local window order and ordinals, the current projection
generation, complete window/tab/group metadata, and one recorded tab.

Positive Chrome focus changes set both focused and projected window. `WINDOW_ID_NONE` retains the last
known Chrome focus and current projection. Selecting an outer window in AgentDesk changes only the
projected window and never calls `chrome.windows.update`. Selecting an inner tab validates membership,
calls `chrome.tabs.update(tabId, {active: true})`, and does not focus the containing window. Only normal
windows are enumerated.

The extension stops the prior recorder before advancing generation whenever the projected window,
selected tab, or selected document changes. The generation is passed into the isolated recorder and
echoed on every batch. The extension, host local session, and renderer each reject a batch unless its
generation and tab id match the current projection. Restricted, loading, and discarded tabs replace the
page with explicit status rather than retaining prior content.

The authenticated native bridge gains a complete validated `browser-state` snapshot and two selection
commands. `browser-state` is routed only to `BrowserProjectionSession`; it never enters `DomMirrorRelay`.
The existing `dom-batch` path still fans the selected page to both the local session and the current
remote page-only relay. This decision does not change the AgentDesk wire protocol.

The shared BrowserProjection webview owns a fixed nested layout: outer window tablist, inner page
tablist, read-only toolbar, page or status content, and build diagnostics. Metadata is inserted through
DOM text properties. It has no create, close, reorder, pin, group, navigation, reload, or window controls.

The autonomous acceptance harness launches only the dev host and a visible Chrome-for-Testing instance
with the checkout extension in a temporary profile. It drives the native shell and both tab levels by
AX identifier, captures window-only screenshots, records focused/projected/generation transitions, and
removes every test-owned process and profile artifact.

### Consequences

- Good, because the local projection matches Chrome's real multi-window hierarchy without taking window-management authority.
- Good, because projection selection and Chrome focus can differ deliberately and visibly.
- Good, because one recorder bounds CPU, debugger banners, and lifecycle cleanup.
- Good, because generation is document-scoped at the recorder source instead of inferred after delivery.
- Bad, because background tabs remain metadata-only and need a recorder handoff before their page appears.
- Bad, because the MV3 worker now reconciles several Chrome event streams and must persist its session identity.
- Neutral, because iOS still receives only the current page until a later decision defines a remote browser-shell contract.

### Confirmation

Unit tests cover ordering, focus/projection separation, command validation, navigation generation, state
validation, nested rendering, and stale-batch filtering. Real extension gates cover recording, trusted
tap, scroll, and emulation. `just browser-projection-e2e` must additionally prove two visible Chrome
windows, projection-only outer selection, unfocused inner-tab activation, direct Chrome follow behavior,
restricted-page clearing, generation advancement, stale-batch rejection, exact build identities,
window-only screenshots, and complete cleanup.

## Links

- Chrome Tabs API, updated 2026-03-03: https://developer.chrome.com/docs/extensions/reference/api/tabs
- Chrome Windows API, updated 2026-05-14: https://developer.chrome.com/docs/extensions/reference/api/windows
- Chrome Tab Groups API, updated 2025-08-11: https://developer.chrome.com/docs/extensions/reference/api/tabGroups
- Chrome favicon guidance, updated 2023-01-11: https://developer.chrome.com/docs/extensions/how-to/ui/favicons
- Chrome Storage API, accessed 2026-07-20: https://developer.chrome.com/docs/extensions/reference/api/storage
- ADR-0039 native-messaging bridge
- ADR-0042 isolated-world recorder
- ADR-0043 compressed batch transport
