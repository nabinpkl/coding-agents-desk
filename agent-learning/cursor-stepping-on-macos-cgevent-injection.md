---
name: cursor-stepping-on-macos-cgevent-injection
description: Trigger-pattern recognizer for the "cursor moves in steps instead of gliding" symptom when injecting mouse motion on macOS via CGEvent. Two real causes (per-sample velocity jitter, MainActor-serialized post) hide behind one misleading symptom that looks like an acceleration problem. Also debunks the kCGMouseEventDeltaX/Y "use OS pointer accel" path that does not work when mouseCursorPosition is set.
metadata:
  type: feedback
---

## When you are doing this

- Driving the macOS cursor by posting `CGEvent` `.mouseMoved` events from your own process (remote desktop client, accessibility tool, iPhone-as-trackpad).
- Source of motion is a stream of small relative deltas (touch samples, mouse polling, network packets).
- You apply some acceleration curve client-side, then post events at a high rate (60-240 Hz).

## And you face this

- The cursor visibly moves in **discrete jumps** instead of gliding, even though the input rate is high.
- Higher gain / speed multiplier makes it worse, not smoother. At 2x it reads as obviously chunky; at 1x it's tolerable.
- Tuning the acceleration curve does not fix it — every curve has the same stepping.
- Setting `kCGMouseEventDeltaX/Y` on the posted event hoping the OS pointer-acceleration pipeline will apply does nothing observable.
- Reading Apple docs sends you in circles: every example sets `mouseCursorPosition`, no example explains why your cursor stutters.

## What is actually wrong

There are usually two unrelated causes stacked, and both have to be fixed before the steps go away. Tuning the curve only papers over them.

### Cause 1: per-sample velocity computed from coalesced-touch dt is wildly unstable

If your input is iOS coalesced touches (`event.coalescedTouches(for:)`), each sample has its own `timestamp`. Computing `speed = hypot(dx, dy) / (sample.timestamp - last.timestamp)` per sample feeds an extremely volatile number into your acceleration curve, because coalesced sample timestamps cluster unevenly within a single UIEvent (inter-sample dt varies ~1-8ms).

For a single physical drag at constant finger speed you can see per-sample velocity vary by 8x, which makes the per-sample gain vary by 5-10x. The result is a row of deltas that look like `2, 10, 3, 8, 2, 12` instead of `5, 5, 5, 5, 5, 5`, and the cursor jumps between large and small steps within one finger sweep.

The fix is to compute velocity over a stable window. Run a `CADisplayLink` while the touch is active, accumulate all coalesced deltas into a buffer in `touchesMoved`, drain the buffer on each display-link tick with `velocity = totalDelta / frameDt`. One emit per display frame, stable velocity feeding the curve.

### Cause 2: posting CGEvents on MainActor serializes them behind UI work

`CGEvent.post(tap: .cghidEventTap)` is a synchronous syscall, typically 1-5ms each. If you receive your input on a background Task and then hop through `await MainActor.run { dispatcher.dispatch(input) }` to post the event, every post blocks the main thread for that duration. Under any UI activity (popover redraws, log rendering, Metal callbacks bouncing through main), the dispatch cadence stalls and CGEvents drain in bursts. The cursor moves in those same bursts.

`CGEvent.post` is thread-safe. The only reason to serialize is to keep your own dispatcher state coherent. Move the post off MainActor onto a dedicated serial `DispatchQueue` (`qos: .userInteractive`). The dispatcher itself wraps each call in `queue.async { ... performDispatch(input) }` so callers can fire-and-forget from any context.

## The acceleration myth: kCGMouseEventDeltaX/Y does not do what you think

Common belief: setting both `mouseCursorPosition` and `kCGMouseEventDeltaX/Y` (and their double-valued counterparts) on the posted event causes macOS to apply its built-in pointer acceleration curve, so the user's "Tracking speed" preference shapes the motion.

This is wrong. macOS pointer acceleration runs in the HID layer **below** CGEvent and cannot be invoked from userspace `CGEvent.post`. When you set `mouseCursorPosition`, the cursor warps to that position and the Delta fields are inert as far as the visible cursor is concerned. (Some apps read the Delta fields for relative-motion logic, but they do not steer the WindowServer cursor.)

So:
- You cannot delegate the curve to macOS. You must apply your own client-side curve.
- Setting the Delta fields alongside `mouseCursorPosition` is dead weight at best, misleading documentation at worst.
- If you need games or accessibility tools to see relative motion via Delta fields, set them with the raw pre-amplification delta. Otherwise don't set them.

Confirmation: try posting an event with **only** Delta fields set (no `mouseCursorPosition`). The cursor does not move. Conversely, set only `mouseCursorPosition` and skip the Delta fields. The cursor moves smoothly with whatever curve you applied client-side.

## Diagnosis checklist

When the symptom appears, walk through these in order before touching the curve math:

1. Are you computing per-sample velocity from coalesced touches? If yes, switch to per-display-frame batching with `CADisplayLink`.
2. Is `CGEvent.post` called from a closure that runs on MainActor (directly, via `await MainActor.run`, or via a `@MainActor` class method)? If yes, move it to a dedicated serial `DispatchQueue`.
3. Are you setting `kCGMouseEventDeltaX/Y` hoping the OS will apply pointer accel? If yes, drop those writes; they do nothing for the visible cursor when `mouseCursorPosition` is set.

If all three are clean and the cursor still steps, the residual is geometric: per-frame jump size is proportional to gain × per-frame finger delta. At very high gain the per-frame jump is necessarily large, and there is no API-side fix — only host-side interpolation that adds latency.

## Real-world incident this came from

iPhone trackpad zone driving the Mac cursor via CGEvent. Cursor visibly stepped at 2x speed even after exhaustive curve tuning. The first two findings (per-sample velocity, MainActor hop) accounted for ~95% of the symptom. The Delta-field cleanup didn't change behaviour but eliminated a comment block that had been actively misleading future-me about what was driving the curve. See commits `30cd87c` (per-coalesced-touch deltas), `d7899b3` (off-MainActor dispatch), `e377ecf` (drop dead Delta writes).
