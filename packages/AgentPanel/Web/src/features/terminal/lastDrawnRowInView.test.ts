import { describe, expect, it } from "vitest";
import { keepLastDrawnRowInView } from "@/features/terminal/lastDrawnRowInView";

/**
 * A mount holding a screen of `rows` rows, `rowHeight` each, starting `screenTop` below the mount's
 * top, with jsdom's missing layout supplied by hand. `scale` is a transform above the mount, which
 * rectangles report and its own pixels do not.
 */
function setUp({
  mountHeight,
  rows,
  rowHeight,
  screenTop,
  scale = 1,
}: {
  mountHeight: number;
  rows: number;
  rowHeight: number;
  screenTop: number;
  scale?: number;
}) {
  const mount = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm";
  const rowsBox = document.createElement("div");
  rowsBox.className = "xterm-rows";
  screen.append(rowsBox);
  mount.append(screen);
  Object.defineProperty(mount, "clientHeight", { value: mountHeight });
  Object.defineProperty(mount, "scrollHeight", { get: () => screenTop + rows * rowHeight });
  Object.defineProperty(mount, "offsetHeight", { value: mountHeight });
  mount.getBoundingClientRect = () => ({ top: 0, bottom: mountHeight * scale, height: mountHeight * scale }) as DOMRect;
  for (let index = 0; index < rows; index++) {
    const row = document.createElement("div");
    row.getBoundingClientRect = () => {
      const top = (screenTop + index * rowHeight - mount.scrollTop) * scale;
      return { top, bottom: top + rowHeight * scale } as DOMRect;
    };
    rowsBox.append(row);
  }
  return { mount };
}

describe("keepLastDrawnRowInView", () => {
  it("scrolls a screen taller than the pane so its last drawn row meets the bottom edge", () => {
    const { mount } = setUp({ mountHeight: 200, rows: 24, rowHeight: 15, screenTop: 12 });
    keepLastDrawnRowInView(mount, 19);
    // Row 19 ends 12 + 20 * 15 = 312 down the screen.
    expect(mount.scrollTop).toBe(112);
  });

  it("lands in the same place under a zoomed-out canvas, whose scale the rectangles carry", () => {
    // The phone's canvas at its fit zoom draws the card at about half size.
    const { mount } = setUp({ mountHeight: 200, rows: 24, rowHeight: 15, screenTop: 12, scale: 0.52 });
    keepLastDrawnRowInView(mount, 19);
    expect(mount.scrollTop).toBeCloseTo(112);
  });

  it("stops at the top once the pane is taller than what is drawn", () => {
    const { mount } = setUp({ mountHeight: 400, rows: 24, rowHeight: 15, screenTop: 12 });
    mount.scrollTop = 50;
    keepLastDrawnRowInView(mount, 19);
    expect(mount.scrollTop).toBe(0);
  });

  it("goes to the end when it does not yet know which row was drawn last", () => {
    const { mount } = setUp({ mountHeight: 200, rows: 24, rowHeight: 15, screenTop: 12 });
    keepLastDrawnRowInView(mount, null);
    expect(mount.scrollTop).toBe(mount.scrollHeight);
  });
});
