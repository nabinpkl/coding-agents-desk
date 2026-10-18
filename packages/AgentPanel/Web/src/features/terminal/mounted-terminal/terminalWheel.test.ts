import { expect, test } from "vitest";
import {
  MAXIMUM_WHEEL_REPORTS,
  sgrWheelReport,
  wheelCell,
  wheelReports,
  wheelRows,
} from "@/features/terminal/mounted-terminal/terminalWheel";

const grid = {
  bounds: { left: 100, top: 50 },
  padding: { left: 8, top: 4 },
  cell: { width: 10, height: 20 },
  columns: 80,
  rows: 24,
};

test("writes the wheel as the report the program asked for", () => {
  // Verbatim what was sent to a live peer's pane on 2026-09-18 and moved its view: button 64 is
  // wheel up, 65 is wheel down, coordinates are one-based, and there is no release form.
  expect(sgrWheelReport("up", 40, 12)).toBe("\u001b[<64;40;12M");
  expect(sgrWheelReport("down", 40, 12)).toBe("\u001b[<65;40;12M");
});

test("converts every unit a wheel arrives in into rows", () => {
  // A mouse reports pixels in notches of about a hundred, a trackpad reports pixels in ones and
  // twos, and a wheel configured for lines or pages reports neither. One accumulator upstream only
  // works if they all become the same thing here.
  expect(wheelRows({ deltaY: 100, deltaMode: 0 }, { height: 20 }, 24)).toBe(5);
  expect(wheelRows({ deltaY: -3, deltaMode: 1 }, { height: 20 }, 24)).toBe(-3);
  expect(wheelRows({ deltaY: 2, deltaMode: 2 }, { height: 20 }, 24)).toBe(48);
});

test("reports nothing for a cell of no height rather than dividing by it", () => {
  expect(wheelRows({ deltaY: 100, deltaMode: 0 }, { height: 0 }, 24)).toBe(0);
});

test("carries the fraction of a row a trackpad moved, so a slow scroll still arrives", () => {
  // Each event from a trackpad is a fraction of a row. Rounding them away individually is how a
  // slow scroll does nothing at all; carrying makes the fourth of four 0.3-row events land.
  let carried = 0;
  const notches: string[] = [];
  for (const rows of [0.3, 0.3, 0.3, 0.3]) {
    const report = wheelReports(carried + rows);
    carried = report.carried;
    if (report.count > 0) notches.push(`${report.direction}x${report.count}`);
  }
  expect(notches).toEqual(["downx1"]);
  expect(carried).toBeCloseTo(0.2, 5);
});

test("takes the direction from the sign and the count from the whole rows", () => {
  expect(wheelReports(-3.5)).toMatchObject({ count: 3, direction: "up" });
  expect(wheelReports(2)).toMatchObject({ count: 2, direction: "down" });
  expect(wheelReports(0.4)).toMatchObject({ count: 0 });
});

test("caps one event's reports, and does not carry what it capped", () => {
  // Each report is a request over the network, so a flick has to be bounded. What is over the cap
  // is dropped rather than carried: a reader who flicked asked to move far, not to go on moving
  // after they stopped.
  const capped = wheelReports(-40);
  expect(capped.count).toBe(MAXIMUM_WHEEL_REPORTS);
  expect(capped.carried).toBe(0);
});

test("places the pointer in the grid inside the terminal's own padding", () => {
  expect(wheelCell({ clientX: 108, clientY: 54 }, grid)).toEqual({ column: 1, row: 1 });
  expect(wheelCell({ clientX: 118, clientY: 74 }, grid)).toEqual({ column: 2, row: 2 });
});

test("clamps a pointer outside the grid instead of refusing the wheel", () => {
  // A wheel event can be delivered with the pointer on the scrollbar, on the padding, or a pixel
  // outside the element mid-resize. The edge cell is the right answer for all of those.
  expect(wheelCell({ clientX: 0, clientY: 0 }, grid)).toEqual({ column: 1, row: 1 });
  expect(wheelCell({ clientX: 9999, clientY: 9999 }, grid)).toEqual({ column: 80, row: 24 });
});

test("answers nothing when the cell has not been measured yet", () => {
  expect(wheelCell({ clientX: 108, clientY: 54 }, { ...grid, cell: { width: 0, height: 0 } })).toBeNull();
});
