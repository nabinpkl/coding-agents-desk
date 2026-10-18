import { describe, expect, it } from "vitest";
import { keepLastDrawnRowInView } from "@/features/terminal/lastDrawnRowInView";

/**
 * A mount holding a screen of `rows` rows, `rowHeight` each, starting `screenTop` below the mount's
 * top, with jsdom's missing layout supplied by hand.
 */
function setUp({
  mountHeight,
  rows,
  rowHeight,
  screenTop,
}: {
  mountHeight: number;
  rows: number;
  rowHeight: number;
  screenTop: number;
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
  mount.getBoundingClientRect = () => ({ top: 0, bottom: mountHeight }) as DOMRect;
  for (let index = 0; index < rows; index++) {
    const row = document.createElement("div");
    row.getBoundingClientRect = () => {
      const top = screenTop + index * rowHeight - mount.scrollTop;
      return { top, bottom: top + rowHeight } as DOMRect;
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
