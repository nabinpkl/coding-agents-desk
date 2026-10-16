import { describe, expect, test } from "vitest";
import { paneRoomBesideTranscript, TRANSCRIPT_FLOOR } from "@/features/terminal/terminalPaneRoom";

/** An element whose box jsdom would otherwise report as zero. */
function box(height: number, flexGrow = "0"): HTMLElement {
  const element = document.createElement("div");
  element.style.flexGrow = flexGrow;
  Object.defineProperty(element, "offsetHeight", { configurable: true, value: height });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: height });
  return element;
}

describe("paneRoomBesideTranscript", () => {
  test("leaves the transcript its floor after a header and the composer around the pane", () => {
    const column = box(650);
    const header = box(40);
    const transcript = box(58, "1");
    const composerBlock = box(589);
    const pane = box(466);
    composerBlock.append(pane);
    column.append(header, transcript, composerBlock);
    // 650 column, 40 header, 123 of composer around the pane: the pane may be 650 - 40 - 123 - floor.
    expect(paneRoomBesideTranscript(pane, column)).toBe(650 - 40 - 123 - TRANSCRIPT_FLOOR);
  });

  test("answers null for a pane that is not inside the column", () => {
    expect(paneRoomBesideTranscript(box(200), box(600))).toBeNull();
  });
});
