# TASKS: v7 local multi-window Chrome projection (with v8 terminal durability captured)

`R<N>` = remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This ledger continues from the archived v6 ledger through D83.

## Position

This iteration makes the macOS Browser Projection model the whole local Chrome hierarchy while keeping
one recorder and one selected page. The extension session and generation contract land first because
the host cannot safely render nested metadata until delayed prior-page batches are distinguishable at
their source. The validated native session and shared renderer follow. Autonomous live verification is
last because it launches the dev host and visible test-owned Chrome and therefore remains behind the
repository launch checkpoint.

Browser metadata is local to the authenticated Unix bridge. The existing QUIC DOM lane remains page-only
for iOS, so this iteration neither changes protocol version 11 nor adds remote browser-shell management.

## v7 Phase 0: local projection decision

- [x] D84. Accept ADR-0063 and update `PRD.md` and `SPEC.md` with the nested local browser hierarchy,
  focus versus projection semantics, one-recorder generation model, local-only metadata boundary, and
  explicit Chrome-management non-goals.

## v7 Phase 1: authoritative extension session

- [x] D85. Replace the focused-tab recorder state in `chrome-extension/worker.js` with a restorable
  multi-window session backed by `chrome-extension/browser-session.js`; enumerate normal windows,
  ordered tabs, groups, and bounded favicons; validate window/tab selection; pass generation into the
  isolated recorder; and test ordering, focus, navigation, restriction, restoration fields, and stale
  command or batch rejection.

## v7 Phase 2: validated local host projection

- [x] D86. Add bounded multi-window state types to `packages/BrowserProjection`, render nested ARIA
  window and tab strips with read-only toolbar/status states, and route validated state plus matching
  page batches through a host-only `BrowserProjectionSession`. Keep `browser-state` out of
  `DomMirrorRelay`; retain selected-page tap, scroll, and existing iOS page-only delivery. Tests pin
  decoding, metadata text safety, AX identifiers, atomic replacement, filtering, and command routing.

## v7 Phase 3: autonomous verification seam

- [x] D87. Add `just browser-projection-verify` and `just browser-projection-e2e`; preflight TCC without
  prompting, build the exact dev host without personal Chrome bridge installation, load the exact
  extension into a temporary visible Chrome-for-Testing profile, drive stable AX identifiers, capture
  window-only screenshots and machine-readable transitions, reuse tap/scroll gates, and clean every
  test-owned process and profile. Pure, renderer, real-extension, focused-host, and repository checks
  must pass before the launch checkpoint.

## v7 Phase 4: live acceptance checkpoint

- [x] D88. After explicit user approval, run `just browser-projection-e2e` and verify two normal Chrome
  windows, complete nested tabs and group metadata, projection-only outer switching, unfocused inner
  tab activation, direct Chrome focus/tab following, restricted-page clearing, strictly advancing
  generations, stale-batch rejection, matching host/extension SHAs, six screenshots, result JSON, and
  complete cleanup without touching the stable host or personal Chrome profile.

---

## v8 scope (captured, not started)

- [ ] R89. Add workspace terminal tabs, splits, and a workspace-filtered session drawer.
- [ ] R90. Add bounded PTY output replay so a fully disconnected client reconstructs prior terminal display state.

## Promotion log

```text
D84      2026-07-20  landed      local multi-window browser projection decision
D85      2026-07-20  landed      restorable extension session and document-scoped generation
D86      2026-07-20  landed      validated nested AppKit projection and local bridge routing
D87      2026-07-20  landed      autonomous AX and temporary-Chrome verification seam
D88      2026-07-20  landed      live dev-host and visible Chrome-for-Testing acceptance
```
