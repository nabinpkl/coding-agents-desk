import { describe, expect, it } from "vitest";
import {
  HEADER_OBSCURED_PX,
  jumpScrollTop,
  selectStickyCurrentIndex,
  selectStickyUserIndex,
  type StickyMeasurement,
  type StickyRow,
} from "@/features/activity-feed/sticky-headers/activityStickyHeaders";

const STICKY_H = 51;

function rows(...kinds: string[]): StickyRow[] {
  return kinds.map((kind) => ({ kind }));
}

/** Stacked rows of the given heights, laid out from 0. */
function stack(...sizes: number[]): StickyMeasurement[] {
  let start = 0;
  return sizes.map((size) => {
    const measurement = { start, size };
    start += size;
    return measurement;
  });
}

describe("sticky user bar", () => {
  it("stays off at rest, including on a thread that does not scroll", () => {
    // The regression this guards: a bar pinned over row 0 at scrollTop 0,
    // restating text the viewer can already read 20px below it, on a thread
    // whose whole content fits the viewport.
    const layout = stack(114, 107);
    expect(selectStickyUserIndex(rows("user", "segment_event"), layout, 0, STICKY_H)).toBeNull();
  });

  it("stays off until the row's own heading has scrolled away", () => {
    const layout = stack(114, 107);
    const list = rows("user", "segment_event");
    expect(selectStickyUserIndex(list, layout, HEADER_OBSCURED_PX - 1, STICKY_H)).toBeNull();
    expect(selectStickyUserIndex(list, layout, HEADER_OBSCURED_PX, STICKY_H)).toBe(0);
  });

  it("pins the most recent user row once scrolled past it", () => {
    const layout = stack(100, 100, 100, 100);
    const list = rows("user", "segment_event", "user", "segment_event");
    expect(selectStickyUserIndex(list, layout, 150, STICKY_H)).toBe(0);
    expect(selectStickyUserIndex(list, layout, 260, STICKY_H)).toBe(2);
  });

  it("flips to an incoming user row as its heading goes behind the bar", () => {
    // Landing exactly on user row 2 must name user 2, never user 0. Naming the
    // older row is the failure the second pass exists to prevent: the bar is
    // covering row 2's heading, so it has to be the one it stands for.
    const layout = stack(100, 100, 100, 100);
    const list = rows("user", "segment_event", "user", "segment_event");
    expect(selectStickyUserIndex(list, layout, 200, STICKY_H)).toBe(2);
  });

  it("never blanks between turns", () => {
    // The bar naming user 0 must hold for every offset from where user 0's
    // heading leaves to where user 2's arrives. A lookahead in the search
    // without one in the suppression opened a gap here.
    const layout = stack(100, 100, 100, 100);
    const list = rows("user", "segment_event", "user", "segment_event");
    for (let scrollTop = HEADER_OBSCURED_PX; scrollTop < 400; scrollTop += 1) {
      expect(selectStickyUserIndex(list, layout, scrollTop, STICKY_H)).not.toBeNull();
    }
  });

  it("returns null when the thread holds no user row", () => {
    expect(
      selectStickyUserIndex(rows("segment_event", "compaction"), stack(80, 40), 300, STICKY_H),
    ).toBeNull();
  });

  it("tolerates measurements the virtualizer has not caught up with", () => {
    expect(selectStickyUserIndex(rows("user", "user"), stack(100), 400, STICKY_H)).toBe(0);
  });
});

describe("sticky current bar", () => {
  it("names the row straddling the top once its heading is hidden", () => {
    const layout = stack(100, 100, 100);
    const list = rows("user", "segment_event", "segment_event");
    expect(selectStickyCurrentIndex(list, layout, 140, STICKY_H, 0)).toBe(1);
  });

  it("stays off while the straddling row's heading is still visible", () => {
    const layout = stack(100, 100, 100);
    const list = rows("user", "segment_event", "segment_event");
    expect(
      selectStickyCurrentIndex(list, layout, 100 + HEADER_OBSCURED_PX - 1, 0, null),
    ).toBeNull();
  });

  it("does not duplicate the row the user bar already stands for", () => {
    const layout = stack(300, 100);
    expect(selectStickyCurrentIndex(rows("user", "segment_event"), layout, 200, 0, 0)).toBeNull();
  });

  it("never pins a compaction banner", () => {
    const layout = stack(100, 100);
    expect(selectStickyCurrentIndex(rows("compaction", "segment_event"), layout, 50, 0, null)).toBeNull();
  });
});

describe("jump target", () => {
  it("lands the row at the top when no bar will remain", () => {
    expect(jumpScrollTop({ start: 480, size: 100 }, 0)).toBe(480);
  });

  it("reserves space only for a bar that survives the jump", () => {
    expect(jumpScrollTop({ start: 480, size: 100 }, STICKY_H)).toBe(429);
  });

  it("never scrolls above the top of the content", () => {
    expect(jumpScrollTop({ start: 10, size: 100 }, STICKY_H)).toBe(0);
  });
});
