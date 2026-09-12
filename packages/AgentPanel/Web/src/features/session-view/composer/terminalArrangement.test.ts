// Whether a pane stands above the field. The property worth pinning is the height basis: without
// it a pane opens at a share of the viewport, which inside a card is more than the whole card.

import { expect, test } from "vitest";
import { terminalArrangement } from "@/features/session-view/composer/terminalArrangement";

test("off shows no pane", () => {
  expect(terminalArrangement(false, true)).toBeNull();
});

test("on shows the pane as a peek above the field", () => {
  expect(terminalArrangement(true, true)).toBe("echo");
});

// A pane mounted before its height reference exists opens at a share of the viewport, which inside
// a card is more than the whole card and squeezes the transcript away.
test("no height basis means no pane, however the session is arranged", () => {
  expect(terminalArrangement(true, false)).toBeNull();
});
