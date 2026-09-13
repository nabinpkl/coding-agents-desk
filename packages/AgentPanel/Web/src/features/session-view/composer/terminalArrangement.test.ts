// What the band puts up. The property worth pinning is that `echo` shows BOTH -- it is the whole
// reason the arrangement stopped being a boolean -- and that the field survives every arrangement
// except the one that explicitly asked for the pane instead of it.

import { expect, test } from "vitest";
import { terminalArrangement } from "@/features/session-view/composer/terminalArrangement";

test("the default shows the field and no pane", () => {
  expect(terminalArrangement("field", true)).toEqual({ pane: null, field: true });
});

test("echo shows the field and a peek at the pane at once", () => {
  expect(terminalArrangement("echo", true)).toEqual({ pane: "echo", field: true });
});

test("terminal gives the whole band to the pane", () => {
  expect(terminalArrangement("terminal", true)).toEqual({ pane: "band", field: false });
});

// A pane mounted before its height reference exists opens at a share of the viewport, which inside
// a card is more than the whole card. The field stays either way: a band with neither surface is
// one nobody can type into.
test("no height basis means no pane, and never a band with nothing to type into", () => {
  expect(terminalArrangement("echo", false)).toEqual({ pane: null, field: true });
  expect(terminalArrangement("terminal", false)).toEqual({ pane: null, field: true });
});
