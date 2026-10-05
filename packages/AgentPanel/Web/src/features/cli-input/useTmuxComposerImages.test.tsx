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

  it("keeps the picture with an image the pane renumbered, because it is the same file", async () => {
    // An edit that retypes across an image makes the sidecar drop its file again, and Claude
    // names the second drop `#2`. Same picture, so the preview follows it rather than the strip
    // turning into a bare number for an image this panel sent.
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await press("drop");
    await act(async () => {
      feed.emit({ ...holding("[Image #1] hi"), images: [{ id: 1, file: "a.png" }] });
    });
    const picture = shown()["1"];
    expect(picture).toMatch(/^blob:/);

    await act(async () => {
      feed.emit({ ...holding("[Image #2] hi"), images: [{ id: 2, file: "a.png" }] });
    });
    expect(shown()).toEqual({ "2": picture });
  });

  it("does not hand a picture to a different image that took a new number", async () => {
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await press("drop");
    await act(async () => {
      feed.emit({ ...holding("[Image #1] hi"), images: [{ id: 1, file: "a.png" }] });
    });
    const first = shown()["1"];
    await act(async () => {
      feed.emit({ ...holding("[Image #2] hi"), images: [{ id: 2, file: "b.png" }] });
    });
    // The drop sent two pictures, so the new image takes the one still waiting, never #1's.
    expect(shown()["2"]).toMatch(/^blob:/);
    expect(shown()["2"]).not.toBe(first);
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

describe("pasted text", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows a chip for a handle the field is carrying, with what the sidecar holds", async () => {
    // Claude keeps a long paste in its own process and leaves `[Pasted text #N]` in the box. The
    // strip is where an attachment belongs; the field is for text a reader can edit, and a handle
    // is not that -- one backspace takes the whole paste.
    const feed = pane("");
    feed.held.set("[Pasted text #1]", "one\ntwo\nthree");
    render(<Probe feed={feed} />);
    await settle();

    await act(async () => {
      feed.emit({
        text: "[Pasted text #1]",
        hint: null,
        reason: null,
        exact: true,
        commands: [],
        pastes: [{ token: "[Pasted text #1]", id: 1, held: { chars: 13, lines: 3 } }],
        images: [],
      });
    });
    expect(screen.getByTestId("pastes").textContent).toBe("[Pasted text #1]:3L13C");
  });

  it("says a paste made at the keyboard is not one it can open", async () => {
    // Different from an empty preview, and the difference is what a reader deciding whether to
    // send can act on: the words exist, they are just inside Claude.
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await act(async () => {
      feed.emit({
        text: "[Pasted text #9 +38 lines]",
        hint: null,
        reason: null,
        exact: true,
        commands: [],
        pastes: [{ token: "[Pasted text #9 +38 lines]", id: 9, held: null }],
        images: [],
      });
    });
    expect(screen.getByTestId("pastes").textContent).toBe("[Pasted text #9 +38 lines]:unheld");
  });

  it("puts the words back in the field, which is how a reloaded panel recovers a message", async () => {
    // The recovery this exists for. A reader whose panel reloaded mid-message comes back to an
    // empty field and a box holding a handle: the message is in the pane and in the sidecar, and
    // nowhere they can change it.
    const feed = pane("");
    feed.held.set("[Pasted text #1]", "the whole message again");
    render(<Probe feed={feed} />);
    await settle();
    await act(async () => {
      feed.emit({
        text: "[Pasted text #1]",
        hint: null,
        reason: null,
        exact: true,
        commands: [],
        pastes: [{ token: "[Pasted text #1]", id: 1, held: { chars: 23, lines: 1 } }],
        images: [],
      });
    });
    expect(draft()).toBe("[Pasted text #1]");

    await press("expand");
    expect(feed.previewed).toEqual(["[Pasted text #1]"]);
    expect(draft()).toBe("the whole message again");
    // And the pane is brought up to date with it, because the field is now the newer copy.
    await settle(200);
    expect(feed.pushes.at(-1)).toBe("the whole message again");
  });

  it("drops the chip the moment the handle leaves the field", async () => {
    // Run off the DRAFT rather than off the reading, the way the image strip is, so removing one
    // shows before the pane has been told.
    const feed = pane("");
    feed.held.set("[Pasted text #1]", "words");
    render(<Probe feed={feed} />);
    await settle();
    await act(async () => {
      feed.emit({
        text: "[Pasted text #1] tail",
        hint: null,
        reason: null,
        exact: true,
        commands: [],
        pastes: [{ token: "[Pasted text #1]", id: 1, held: { chars: 5, lines: 1 } }],
        images: [],
      });
    });
    expect(screen.getByTestId("pastes").textContent).toBe("[Pasted text #1]:1L5C");

    await press("unpaste");
    expect(screen.getByTestId("pastes").textContent).toBe("");
    expect(draft()).toBe("tail");
  });
});
