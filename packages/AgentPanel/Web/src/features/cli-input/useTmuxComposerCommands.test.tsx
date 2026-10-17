import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  holding,
  pane,
  Probe,
  type,
} from "@/features/cli-input/useTmuxComposerHarness";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the commands a session offers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the menu the pane is showing, and drops it when the pane does", async () => {
    const feed = pane();
    render(<Probe feed={feed} />);
    expect(screen.getByTestId("commands").textContent).toBe("");

    await act(async () => {
      feed.emit({
        text: "/re",
        hint: null,
        reason: null,
        exact: true,
        commands: [
          { name: "/recap", description: "Generate a one-line session recap now", selected: true },
          { name: "/rename", description: "Rename the current conversation", selected: false },
        ],
        pastes: [], images: [],
      });
    });
    expect(screen.getByTestId("commands").textContent).toBe(">/recap /rename");

    // The menu closes in the pane when the name is complete, and the panel follows it rather than
    // holding a list of what is no longer on offer.
    await act(async () => feed.emit(holding("/rename ")));
    expect(screen.getByTestId("commands").textContent).toBe("");
  });

  it("does not let a push empty the list the stream just filled", async () => {
    // A push answers with what it ASKED the box to hold; it cannot know the menu Claude then draws
    // under it. Taking the menu from that answer would blank the list on every keystroke and let
    // the stream put it back a moment later -- a list that flickers away under the thumb reaching
    // for it.
    const feed = pane();
    render(<Probe feed={feed} />);
    await act(async () => {
      feed.emit({
        text: "/re",
        hint: null,
        reason: null,
        exact: true,
        commands: [{ name: "/recap", description: "one line", selected: true }],
        pastes: [], images: [],
      });
    });
    await type("/rec");
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(feed.pushes).toEqual(["/rec"]);
    expect(screen.getByTestId("commands").textContent).toBe(">/recap");
  });

  it("takes a command by typing it, with the space that completes the name", async () => {
    // Measured on a live pane: the trailing space is what closes the menu and makes Claude show
    // its own argument hint instead. It goes through the ordinary debounced push, so choosing a
    // command and typing one are the same act and there is no second way into the pane.
    const feed = pane();
    render(<Probe feed={feed} />);
    await act(async () => {
      fireEvent.click(screen.getByText("choose"));
    });
    expect(screen.getByTestId("draft").textContent).toBe("/rename ");
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(feed.pushes).toEqual(["/rename "]);
  });

  it("keeps the draft when the pane's reading is not exact", async () => {
    // What the argument hint costs if this is missed: the box reads "/rename  [name]" while the
    // reader typed "/rename ", and adopting it would put Claude's annotation in their field and
    // then type it into their session for real.
    const feed = pane();
    render(<Probe feed={feed} />);
    await type("/rename ");
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    await act(async () => {
      feed.emit({
        text: "/rename  [name]",
        hint: null,
        reason: null,
        exact: false,
        commands: [], pastes: [], images: [],
      });
    });
    expect(screen.getByTestId("draft").textContent).toBe("/rename ");
  });
});
