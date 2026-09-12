"use client";

// The streams a desktop shows: the whole display, the coarse overview under a crop, and
// the sharp detail over it.

import { TileStreamRtc } from "@/features/desktop-viewer/tile-stream/TileStreamRtc";
import { useCaptureScale } from "@/features/desktop-viewer/zoom/captureScale";
import { captureCropApplied, useCaptureCrop } from "@/features/desktop-viewer/zoom/captureCrop";

/**
 * The stream, subscribed to the capture multiplier and the capture plan.
 *
 * This exists so the subscriptions live BELOW the viewport rather than above it. Reading either
 * value in the surface would re-render the surface, which rebuilds the element handed to
 * `TileViewport` as `children` and disturbs the effect holding its view and cursor. Here, a
 * resolution or plan change re-renders this component alone and the view around it does not move.
 * That matters more for the plan than for the multiplier, because the plan is produced by that
 * very effect: routing it upwards would let each settled zoom reset the view it came from.
 */
export function DesktopStream(
  props: Omit<Parameters<typeof TileStreamRtc>[0], "captureScale" | "capturePlan">,
) {
  const { onFirstFrame, ...rest } = props;
  return (
    <TileStreamRtc
      {...rest}
      captureScale={useCaptureScale()}
      capturePlan={useCaptureCrop()}
      // The stream is what knows when a requested plan became visible, and the viewport is what
      // has to start placing the frame by that plan's region at that instant. Announcing it here
      // keeps those two from having to know about each other.
      onFirstFrame={() => {
        captureCropApplied();
        onFirstFrame?.();
      }}
    />
  );
}

/** The coarse whole-display stream: no plan, ever, and the ordinary control owner. */
export function OverviewStream(
  props: Omit<Parameters<typeof TileStreamRtc>[0], "captureScale" | "capturePlan" | "control">,
) {
  // Viewport-sized, as DeskZoom's overview is its window's backing size: the resolution knob is
  // for a single stream. Applied here it sent a phone a 3858-wide overview beside the sharp
  // stream, and the link dropped both.
  return <TileStreamRtc {...props} captureScale={1} capturePlan={null} />;
}

/**
 * The sharp cropped stream: the store's plan, mounted only while there is one, and never the
 * control owner, since the overview beneath it already is. Its first frame is the swap signal.
 */
export function DetailStream(
  props: Pick<Parameters<typeof TileStreamRtc>[0], "windowID" | "displayId" | "fill" | "httpTransport">,
) {
  const plan = useCaptureCrop();
  // Both hooks before the early return: a hook that runs only once a plan exists changes the
  // hook count between renders, and React answers that by unmounting the whole tree to white.
  const captureScale = useCaptureScale();
  if (!plan) return null;
  return (
    <TileStreamRtc
      {...props}
      captureScale={captureScale}
      capturePlan={plan}
      control={false}
      onFirstFrame={captureCropApplied}
    />
  );
}
