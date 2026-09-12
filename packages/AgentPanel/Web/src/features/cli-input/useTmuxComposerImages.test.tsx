import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  draft,
  holding,
  pane,
  press,
  Probe,
  SESSION,
  settle,
  type,
} from "@/features/cli-input/useTmuxComposerHarness";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the images a composer is holding", () => {
  /** Which number holds which picture, as the strip would render it. */
  function shown(): Record<string, string> {
    const text = screen.getByTestId("images").textContent ?? "";
    return Object.fromEntries(
      text.split(" ").filter(Boolean).map((entry) => {
        const split = entry.indexOf(":");
        return [entry.slice(0, split), entry.slice(split + 1)];
      }),
    );
  }

  it("gives each picture the number the pane gave it, not the one this side guessed", async () => {
    // Which number an image gets belongs to Claude, and the pane only says so when it redraws.
    // So the picture waits, and takes a number that was not in the box before.
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await press("drop");
    expect(shown()).toEqual({});

    await act(async () => { feed.emit(holding("[Image #7] [Image #8]")); });
    const strip = shown();
    expect(Object.keys(strip)).toEqual(["7", "8"]);
    expect(strip["7"]).toMatch(/^blob:/);
    // Two images, two pictures: they are not the same one shown twice.
    expect(strip["7"]).not.toBe(strip["8"]);
  });

  it("shows an image somebody else put in the box, as its number", async () => {
    // Dropped into the pane by whoever is sitting there: the box says it is holding an image and
    // this panel has never seen the bytes. Named rather than hidden, so the strip and the text
    // never disagree about how many there are.
    const feed = pane("[Image #2] look at this");
    render(<Probe feed={feed} />);
    await settle();
    expect(shown()).toEqual({ "2": "none" });
  });

  it("drops a picture the moment its token leaves the field, before the pane is told", async () => {
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await press("drop");
    await act(async () => { feed.emit(holding("[Image #7] [Image #8]")); });
    const kept = shown()["7"]!;

    await type("[Image #7]");
    // The one still in the field keeps the picture it had; the other is gone with its token.
    expect(shown()).toEqual({ "7": kept });
  });

  it("takes an image out by deleting its token, and the space that was in front of it", async () => {
    // Removing an image IS deleting the token: the picture is keyed to it, and Claude drops an
    // entry that nothing in the text refers to. So it rides the ordinary push rather than a
    // second way into the pane.
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await press("drop");
    await act(async () => { feed.emit(holding("alpha [Image #7] omega")); });
    expect(Object.keys(shown())).toEqual(["7"]);

    await act(async () => { screen.getByText("remove").click(); });
    expect(draft()).toBe("alpha omega");
    // And a token at the head of the box does not leave the text starting with a space. Typed
    // here rather than announced, because an unsent edit is what the reading is guarded against.
    await type("[Image #7] omega");
    await act(async () => { screen.getByText("remove").click(); });
    expect(draft()).toBe("omega");
    // The picture goes with the token, before the pane has even been told.
    expect(shown()).toEqual({});
    await settle(200);
    // Carried by the ordinary push, which is the point: there is no second way into the pane.
    expect(feed.pushes.at(-1)).toBe("omega");
  });

  it("keeps no picture waiting once the box is emptied", async () => {
    // A submitted turn takes its images with it. A picture still waiting for a number it will
    // never get would be handed to the next image dropped, which is a wrong thumbnail.
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await press("drop");
    await act(async () => { feed.emit(holding("[Image #7] [Image #8]")); });
    const submitted = Object.values(shown());
    await act(async () => { feed.emit(holding("")); });
    expect(shown()).toEqual({});

    await press("drop");
    await act(async () => { feed.emit(holding("[Image #9]")); });
    // A picture sent after the turn went, not one the turn took away.
    expect(submitted).not.toContain(shown()["9"]);
  });

  it("sends a rail key straight through, without flushing the draft first", async () => {
    // These keys are how a reader corrects the box. Pushing the draft ahead of one would send the
    // very text they are about to take back.
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await type("a mistake");
    await act(async () => { fireEvent.click(screen.getByText("escape")); });
    expect(feed.keys).toEqual([{ key: "escape", modifiers: { ctrl: false, alt: false, shift: false } }]);
    expect(feed.pushes).toEqual([]);
  });

  it("arms a modifier for one key and spends it there", async () => {
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await act(async () => { fireEvent.click(screen.getByText("ctrl")); });
    expect(screen.getByTestId("modifiers").textContent).toContain("ctrl:armed");
    await act(async () => { fireEvent.click(screen.getByText("left")); });
    expect(feed.keys.at(-1)).toEqual({ key: "left", modifiers: { ctrl: true, alt: false, shift: false } });
    // Spent: the next key goes unmodified.
    expect(screen.getByTestId("modifiers").textContent).toContain("ctrl:off");
    await act(async () => { fireEvent.click(screen.getByText("left")); });
    expect(feed.keys.at(-1)!.modifiers.ctrl).toBe(false);
  });

  it("holds a locked modifier across keys until it is tapped off", async () => {
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    // Off, armed, locked: the order a phone's shift key taught everyone.
    await act(async () => { fireEvent.click(screen.getByText("ctrl")); });
    await act(async () => { fireEvent.click(screen.getByText("ctrl")); });
    expect(screen.getByTestId("modifiers").textContent).toContain("ctrl:locked");
    await act(async () => { fireEvent.click(screen.getByText("left")); });
    await act(async () => { fireEvent.click(screen.getByText("left")); });
    expect(feed.keys.every((press) => press.modifiers.ctrl)).toBe(true);
    expect(screen.getByTestId("modifiers").textContent).toContain("ctrl:locked");
  });

  it("lets the pane say what a rail key did, rather than guessing", async () => {
    // An arrow moves a cursor and Escape may clear the box: neither is predictable from here, so
    // the reading that follows is adopted instead of being held off by an unsent edit.
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await type("half a thought");
    await act(async () => { fireEvent.click(screen.getByText("escape")); });
    await act(async () => { feed.emit(holding("")); });
    expect(draft()).toBe("");
  });
});
