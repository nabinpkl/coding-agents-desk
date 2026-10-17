import { describe, expect, it } from "vitest";
import { keepLastDrawnRowInView } from "@/features/terminal/lastDrawnRowInView";

/**
 * A mount holding a screen of `rows` rows, `rowHeight` each, starting `screenTop` below the mount's
 * top, with jsdom's missing layout supplied by hand: a margin on the screen moves every row down.
 */
function setUp({ mountHeight, rows, rowHeight, screenTop }: { mountHeight: number; rows: number; rowHeight: number; screenTop: number }) {
  const mount = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm";
  const rowsBox = document.createElement("div");
  rowsBox.className = "xterm-rows";
  screen.append(rowsBox);
  mount.append(screen);
  Object.defineProperty(mount, "clientHeight", { value: mountHeight });
  Object.defineProperty(mount, "scrollHeight", { get: () => screenTop + rows * rowHeight + (parseFloat(screen.style.marginTop) || 0) });
  mount.getBoundingClientRect = () => ({ top: 0, bottom: mountHeight } as DOMRect);
  for (let index = 0; index < rows; index++) {
    const row = document.createElement("div");
    row.getBoundingClientRect = () => {
      const top = screenTop + (parseFloat(screen.style.marginTop) || 0) + index * rowHeight - mount.scrollTop;
      return { top, bottom: top + rowHeight } as DOMRect;
    };
    rowsBox.append(row);
  }
  return { mount, screen };
}

describe("keepLastDrawnRowInView", () => {
  it("scrolls a screen taller than the pane so its last drawn row meets the bottom edge", () => {
    const { mount, screen } = setUp({ mountHeight: 200, rows: 24, rowHeight: 15, screenTop: 12 });
    keepLastDrawnRowInView(mount, 19);
    // Row 19 ends 12 + 20 * 15 = 312 down the screen.
    expect(mount.scrollTop).toBe(112);
    expect(screen.style.marginTop).toBe("");
  });

  it("lowers the screen instead once the pane is taller than what is drawn", () => {
    // The drag case: scrolling cannot go below zero, so without the margin the text rode up.
    const { mount, screen } = setUp({ mountHeight: 400, rows: 24, rowHeight: 15, screenTop: 12 });
    keepLastDrawnRowInView(mount, 19);
    expect(mount.scrollTop).toBe(0);
    expect(screen.style.marginTop).toBe("88px");
    const last = mount.querySelector(".xterm-rows")!.children[19]!;
    expect(last.getBoundingClientRect().bottom).toBe(400);
  });

  it("does not count an earlier lowering twice when it runs again", () => {
    const { mount, screen } = setUp({ mountHeight: 400, rows: 24, rowHeight: 15, screenTop: 12 });
    keepLastDrawnRowInView(mount, 19);
    keepLastDrawnRowInView(mount, 19);
    expect(screen.style.marginTop).toBe("88px");
  });

  it("goes to the end when it does not yet know which row was drawn last", () => {
    const { mount } = setUp({ mountHeight: 200, rows: 24, rowHeight: 15, screenTop: 12 });
    keepLastDrawnRowInView(mount, null);
    expect(mount.scrollTop).toBe(mount.scrollHeight);
  });
});
