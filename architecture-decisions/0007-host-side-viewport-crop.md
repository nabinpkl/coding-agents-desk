---
status: superseded by ADR-0008
date: 2026-05-23
---

# Host-side viewport crop for zoom sharpness

## Context and Problem Statement

R21 (pinch-to-zoom on the iPhone) shipped local-only zoom in `PairingViewController.mountSinkView` by wrapping the WebRTC sink view in a `UIScrollView`. Past ~2x local zoom, text becomes visibly soft because the host streams the full Mac display at fixed encoder dimensions and the client is upscaling already-downsampled pixels. The fix is to crop the captured region on the host so the visible area encodes at higher per-source-pixel density. The question is: what gestures trigger a crop change, how is the client→host transition shaped, and how do we handle the pinch-out case where the user wants pixels that aren't being captured anymore.

Affected modules: `host/AgentDeskHost/ScreenCaptureKitFrameSource.swift`, `host/AgentDeskHost/VideoFrameSource.swift`, both `SharedTypes.swift`, `host/AgentDeskHost/AppDelegate.swift`, `client/AgentDeskClient/PairingViewController.swift`.

## Decision Drivers

- Sharpness at high zoom is the felt-friction motivator. The whole point of R21 Path B is that 4x effective zoom shows readable text, not magnified blur.
- Pinch-out must feel smooth. The user can't see pixels that aren't being captured; if the host is cropped to a sub-region and the user pinches out, there's a window where the wider area shows black or stretched edges until the host responds.
- Throttle stream reconfigure cost. `SCStream.updateConfiguration` forces a fresh IDR keyframe and a brief encoder reconfigure (~1-2 frames). Per-frame viewport updates would keyframe-storm the encoder.
- Reuse the existing `client-config` frame. No new message type if we can extend an existing one.
- Keep the SkyLight + ScreenCaptureKit surface area roughly where it is. We already pay the macOS-upgrade canary cost on those; not adding new private symbols.

## Considered Options

- **Option A: send viewport on pinch-end only.** Client computes the visible rect when the gesture settles, sends one frame. Host applies. Simple, but pinch-out gets stuck waiting for the host because crop is still narrow when the user starts pinching outward.
- **Option B: send viewport continuously during pinch.** Every `scrollViewDidZoom` callback sends a new rect. Host updates per tick. Keyframe-storms the encoder and burns CPU; rejected on the throttle driver.
- **Option C: send viewport on pinch-end PLUS active prefill on pinch-start.** When the user begins any pinch gesture, if the host currently has an active crop, immediately send `viewport: nil` (full display). Host widens before the gesture even decides direction. On pinch-end, if the final zoom is above the threshold, send the new viewport. Pinch-out gets the wider stream pre-staged; pinch-in pays a brief glitch but lands sharp.
- **Option D: viewport ack protocol with local-zoom reset.** Host sends a `viewport-ack` when the new sourceRect is applied; client resets local zoom to 1.0 atomically on receipt. Glitch-free but adds a server-side frame type and a coordination dance.

## Decision Outcome

Chose **Option C** (pinch-end snapshot + active prefill on pinch-start), rejecting Option D's added complexity.

Option C wins on the pinch-out driver: prefill at gesture start means by the time the user releases at a low zoom level, the host has already snapped back to full display, so the user's wider visible area is already being streamed. The cost is one keyframe per pinch gesture (vs. Option A's zero) which is acceptable at human-input cadence (~once per few seconds).

Option D's ack protocol is rejected for v0 because the visual artifact Option C accepts — one or two frames of stretched/older pixels at the moment of viewport handoff — is small enough that empirical testing should validate it before adding a host→client coordination frame.

Local zoom and crop stay **decoupled**. The user's local `scrollView.zoomScale` is independent of the host crop. Effective zoom = local × crop. We do not reset local zoom when the crop applies; the same visible area gets sharper pixels because the encoder is now spending its bit budget on a smaller source region.

Cursor wire shape is **unchanged**. Cursor input still rides `NormalizedInput.cursorMove(dx, dy)` and the host's `InputDispatcher` posts CGEvents in full-display point coords. The user pans the scroll view or sweeps the trackpad to find a cursor that's drifted off the visible viewport. "Tap-to-warp" / Microsoft-RDP touch-mode is captured as a v2 follow-up, not this ADR.

Output frame size stays pinned to the full display in both branches. The crop changes `SCStreamConfiguration.sourceRect` only, not `config.width`/`config.height`. SCK then maps the sub-rect into the same-size output frame, so each source pixel covers more output pixels: that is the density gain. An earlier revision resized the output frame to match the cropped sub-rect, which cancelled the gain by downsampling the sub-rect back to its own size; that variant is not the chosen behavior.

### Consequences

- Good, because text-quality at high zoom is the felt-friction motivator and this fixes it without restructuring the WebRTC pipeline.
- Good, because the wire shape extends an existing frame (`client-config` gains an optional `viewport` field) rather than adding a new message type. Disabled clients (or clients not zoomed) send nothing and the host stays at full display.
- Good, because active prefill mitigates the pinch-out artifact without requiring server-initiated coordination frames.
- Bad, because every pinch gesture costs one IDR keyframe even if the user lands back at zoom = 1.0. At typical user pinch frequency (~once per minute), this is fine; if a user is "exploring by pinching" repeatedly, the encoder cost rises.
- Bad, because the moment of viewport handoff carries a 1-2 frame visual artifact: the user sees the OLD (full or previously-cropped) frame rendered at the NEW local zoom for one render tick before the new viewport's frames arrive. Acceptable for v0; revisitable via Option D if it surfaces in daily-driver use.
- Neutral, because the threshold (1.5x final zoom to trigger a crop) is a guess. Lower means more crops, more keyframes; higher means more of the local-zoom blur the user is already complaining about. Knob.

### Confirmation

- Live integration verifies sharpness improvement on the host's actual display.
- `ScreenCaptureKitFrameSource` unit-testable surface area is the rect mapping (normalized → display points), which gets a small pure-function test.
- Manual UX check: pinch in to ~3x, release; text should snap sharp within ~200ms. Pinch out from there to ~1x; the wider area should already be streaming by the time the gesture ends (no black bars).

## Pros and Cons of the Options

### Option C (chosen)

- Good, because pinch-out is the felt-friction case and prefill addresses it directly without server-side coordination.
- Good, because the wire shape is one field on an existing frame.
- Neutral, because local zoom and crop are independent variables, which is conceptually clean but means the user's "current zoom" is the product of two state pieces.
- Bad, because every pinch costs a keyframe even when the user pinches and releases at the same zoom.

### Option A

- Good, because cheapest implementation.
- Bad, because pinch-out is broken: when the host is cropped and the user wants to see a wider area, the gesture has to complete before the host widens, leaving the user staring at stretched edges for the round-trip duration.

### Option D

- Good, because glitch-free transition.
- Bad, because it adds a host-initiated `viewport-ack` frame, a coordination state on both sides, and the failure modes (ack lost in transit, ack arrives after a second gesture started) are non-trivial.

## Links

- ADR-0001 v0 stack and transport.
- ADR-0004 media transport seams.
- ADR-0006 Spaces thumbnail capture (precedent for opt-in client-config routing through the input WSS).
- Apple developer docs for `SCStreamConfiguration.sourceRect`, https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/sourcerect (no date verifiable).
- Apple developer docs for `SCStream.updateConfiguration(_:completionHandler:)`, https://developer.apple.com/documentation/screencapturekit/scstream (no date verifiable).
