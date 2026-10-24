# TASKS: v12 complete Claude and Codex JSONL activity feed

`R<N>` = remaining. Flip to `D<N>` once landed and tests are green.

## Position

The ATC parser and dashboard contract lands before AgentDesk transport consumes it. Shared wire shapes come next so host and client compile against one source. Automated cross-platform builds precede the launch checkpoint; live macOS and iOS smoke remains gated until the user approves the exact launch.

## Phase 1: shared raw-event contract

- D1. Extend `packages/AgentDeskWire/Sources/AgentDeskWire/AgentFeed.swift` with block labels and add `AgentRawEvent.swift` for direct, fragmented, and error responses.
- D2. Pin System, metadata, Plain, label, direct transfer, invalid transfer, expiry, concurrency, and exact 100 MiB reconstruction in `AgentRawEventTests.swift`.

## Phase 2: host and client transport

- D3. Wire `AgentFeedBridge` and `HttpSidecarClient` to the exact ATC raw endpoint, using direct local delivery and 2 MiB input-lane fragments only when the encoded response exceeds 4 MiB.
- D4. Serialize Agent pushes through `InputChannelServer` and reassemble bounded fragment transfers in `OwnedMediaTransport` before delivering one response to the shared AgentPanel webview.
- D5. Extend `AgentPanelRequest`, macOS bridge routing, iOS request routing, and host bridge tests for the complete request lifecycle.

## Phase 3: verification

- D6. Rebuild sidecar and webview only through `just build-agent-sidecar` and `just build-agent-webview`, then pass `just check` and a compile-only generic iOS Simulator build.
- R7. Complete the live fragmented-response leg. The approved macOS and iOS shared-feed run verified Plain, metadata, Raw JSON, and Reasoning. Existing records above 4 MiB are outside the dashboard's 30-session project window, so the live UI could not request one without adding a test-only route; the direct 13,855,661-byte endpoint response and the automated fragmented-transfer/100 MiB boundary tests remain green.

## Promotion log

```
D1-D2    2026-07-18  committed   shared activity and bounded raw-event transfer contract
D3-D5    2026-07-18  committed   host and client raw-event lifecycle
D6       2026-07-18  committed   generated artifacts and automated cross-platform gates green
R7       2026-07-18  partial     macOS+iOS semantic/raw feed green; live fragmented UI leg remains
```
