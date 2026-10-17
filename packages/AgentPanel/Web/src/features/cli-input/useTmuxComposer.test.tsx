import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  draft,
  holding,
  pane,
  press,
  Probe,
  settle,
  type,
} from "@/features/cli-input/useTmuxComposerHarness";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("tmux composer", () => {
  it("fills the field from the pane's own box before anyone types", async () => {
    // The stream opens with what the box holds, because an idle pane never writes and a mirror
    // that waited for output would sit empty beside a composer that was not.
    const feed = pane("make the hover ring stronger");
    render(<Probe feed={feed} />);
    await settle();
    expect(draft()).toBe("make the hover ring stronger");
    expect(screen.getByTestId("mirrored").textContent).toBe("true");
    expect(screen.getByTestId("paned").textContent).toBe("true");
    expect(feed.subscribes).toBe(1);
  });

  it("knows the pane is there while a dialog is standing in the composer's place", async () => {
    // A question dialog replaces the box entirely, so every reading for its whole duration is
    // `no-composer`. The field correctly stays away -- there is nothing to mirror -- but the pane
    // is the session's real terminal throughout, and a surface that drives its KEYBOARD has to be
    // told so. Latching both on the box is what left a reader who opened a session because it
    // asked them a question being told the session had no terminal.
    const feed = pane(
      "",
      { text: null, hint: null, reason: "no-composer", exact: true, commands: [], pastes: [], images: [] },
    );
    render(<Probe feed={feed} />);
    await settle();
    expect(screen.getByTestId("mirrored").textContent).toBe("false");
    expect(screen.getByTestId("paned").textContent).toBe("true");
  });

  it("does not claim a pane for a session that has none", async () => {
    const feed = pane("", { text: null, hint: null, reason: "no-pane", exact: true, commands: [], pastes: [], images: [] });
    render(<Probe feed={feed} />);
    await settle();
    expect(screen.getByTestId("paned").textContent).toBe("false");
  });

  it("pushes what was typed, and only after the keystrokes stop", async () => {
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    for (const value of ["m", "ma", "mak", "make"]) await type(value);
    // Nothing yet: four keystrokes inside one debounce window are one push, not four.
    expect(feed.pushes).toEqual([]);
    await settle(200);
    expect(feed.pushes).toEqual(["make"]);
    expect(feed.box).toBe("make");
  });

  it("keeps one push in the air at a time, and sends the newest text when it lands", async () => {
    // The reader's bug. The debounce decides when to push, not how many may be in flight, and over
    // a slow link a request outlives its own 90ms window. Two pushes then read the same box in the
    // sidecar and both paste their whole text, and even serialised there they can arrive in the
    // order the network chose rather than the order they were sent -- leaving the box holding an
    // older draft than the reader has typed.
    const feed = pane("");
    let release: (() => void) | null = null;
    const slow = feed.syncTmuxComposer;
    feed.syncTmuxComposer = async (session, text) => {
      const held = new Promise<void>((wake) => { release = wake; });
      await held;
      return slow(session, text);
    };

    render(<Probe feed={feed} />);
    await settle();
    await type("a");
    await settle(200);
    expect(feed.pushes).toEqual([]);
    expect(release).not.toBeNull();

    // More typing while that request is still out. It must not start a second one.
    await type("ab");
    await settle(200);
    await type("abc");
    await settle(200);
    expect(feed.pushes).toEqual([]);

    // The first lands, and what follows is ONE more push carrying the newest text rather than one
    // per keystroke that went by.
    const first = release!;
    release = null;
    await act(async () => { first(); });
    await settle(200);
    expect(feed.pushes).toEqual(["a"]);
    expect(release).not.toBeNull();
    await act(async () => { release!(); });
    await settle(200);
    expect(feed.pushes).toEqual(["a", "abc"]);
    expect(feed.box).toBe("abc");
  });

  it("does not let a message from the pane overwrite an edit that has not reached it yet", async () => {
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    // Somebody else typed into the pane at the same moment as this reader typed here. The reader's
    // own text is newer than anything a screen can show, so the message must leave it alone.
    await type("mine");
    await act(async () => { feed.emit(holding("theirs")); });
    expect(draft()).toBe("mine");
    // And once the push lands, the pane holds the reader's text rather than the other way round.
    await settle(200);
    expect(feed.box).toBe("mine");
  });

  it("adopts what the terminal half typed, once this half has nothing unsent", async () => {
    // The reverse direction, and the reason the read is a poll rather than a focus-gated watch:
    // a screen has no change event, and typing in the pane has to show up here.
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    feed.box = "typed in the pane itself";
    await act(async () => { feed.announce(); });
    expect(draft()).toBe("typed in the pane itself");
  });

  it("will not overwrite a draft with a reading it cannot trust to the character", async () => {
    // A wrapped composer is reconstructed by guessing the space the wrap consumed. Filling an
    // empty field with a guess costs nothing; replacing typed text with one loses a character.
    const feed = pane("alpha bravo charlie");
    render(<Probe feed={feed} />);
    await settle();
    await act(async () => { feed.announce(true); });
    expect(draft()).toBe("alpha bravo charlie");

    await type("something the reader typed");
    await act(async () => { feed.emit(holding("alpha bravo charlie", true)); });
    await settle(200);
    expect(draft()).toBe("something the reader typed");
  });

  it("keeps a long message when Claude collapses the push into a pasted-text token", async () => {
    // Measured on a live pane (v2.1.263): a bracketed paste of more than 800 characters, or of
    // more than three lines, is replaced in the box by `[Pasted text #N]`. The panel's own pushes
    // cross that line the moment somebody writes a real message, so the reading that comes back
    // names a handle to words that now live only inside Claude.
    //
    // Adopting it was the whole of the bug. The field showed `[Pasted text #1]` in place of the
    // message still being written, and the next keystroke pushed that token back as literal text,
    // which detaches the paste in the pane -- so the message existed nowhere at all.
    const message = "zebra ".repeat(150);
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await type(message);
    await settle(200);
    expect(feed.pushes.at(-1)).toBe(message);

    await act(async () => { feed.emit(holding("[Pasted text #1]")); });
    expect(draft()).toBe(message);

    // And it stays the reader's words through the next keystroke, which is what the pane is
    // brought back into agreement with.
    await type(`${message}!`);
    await settle(200);
    expect(feed.pushes.at(-1)).toBe(`${message}!`);
  });

  it("adopts a pasted-text token the field is already carrying", async () => {
    // The guard above is about a token the draft does NOT hold, because that one can only be
    // standing in for the draft itself. A token already in the field came from the pane in the
    // first place, and an edit beside it is an ordinary two-way reading.
    const feed = pane("[Pasted text #3 +38 lines]");
    render(<Probe feed={feed} />);
    await settle();
    expect(draft()).toBe("[Pasted text #3 +38 lines]");

    await act(async () => { feed.emit(holding("[Pasted text #3 +38 lines] and this too")); });
    expect(draft()).toBe("[Pasted text #3 +38 lines] and this too");
  });

  it("brings the pane up to date before pressing Return, so half a sentence is never sent", async () => {
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await type("send this whole thing");
    // Submitted while the debounce was still counting down, which is what pressing Enter fast is.
    await act(async () => {
      screen.getByText("send").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(feed.pushes.at(-1)).toBe("send this whole thing");
    expect(feed.submits).toBe(1);
    expect(draft()).toBe("");
  });

  it("sends the draft typed during a dialog once the composer comes back", async () => {
    // A `/model` picker, a `/resume` list or a permission prompt replaces the box with an option
    // list, and the sidecar reads that as `no-composer` for as long as it is open -- measured at
    // fourteen seconds for a picker, against milliseconds for the redraw this reason used to be
    // named after. A reader typing through one gets their push refused, which is correct.
    //
    // What was wrong is what happened next. The refusal leaves `edited` set, the stream will not
    // adopt over an unsent edit, and the push only ever woke on the draft moving -- so a reader
    // who typed during the dialog and then waited had text in a field the band had just stopped
    // warning about, mirroring nothing.
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    const dialog = { text: null, hint: null, reason: "no-composer" as const, exact: true, commands: [], pastes: [], images: [] };
    feed.syncTmuxComposer = async () => dialog;
    await act(async () => feed.emit(dialog));

    await type("the sentence the reader cares about");
    await settle(200);
    // Refused, and not retried into a box that cannot take it.
    expect(feed.pushes).toEqual([]);
    expect(screen.getByTestId("reason").textContent).toBe("no-composer");
    expect(draft()).toBe("the sentence the reader cares about");

    // Escape, in the pane. The picker closes, Claude draws its box again, and the watcher says so.
    feed.syncTmuxComposer = async (_session, text) => {
      feed.pushes.push(text);
      feed.box = text;
      return holding(text);
    };
    await act(async () => feed.emit(holding("")));
    // Without a keystroke of its own: the reading that says the box is back is what sends it.
    await settle(200);
    expect(feed.pushes).toEqual(["the sentence the reader cares about"]);
    expect(feed.box).toBe("the sentence the reader cares about");
    expect(screen.getByTestId("reason").textContent).toBe("-");
  });

  it("does not blank the box of a session it has only just opened", async () => {
    // The other direction of the same wake-up, and the one that would be a disaster. Coming back
    // reachable pushes, so a card opening on a session whose reader has typed nothing must not
    // count as an edit: `edited` is what separates them, and it is false until somebody types.
    const feed = pane("what the person at that keyboard was writing");
    render(<Probe feed={feed} />);
    await settle(200);
    await act(async () => feed.emit(holding(feed.box)));
    await settle(200);
    expect(feed.pushes).toEqual([]);
    expect(feed.box).toBe("what the person at that keyboard was writing");
  });

  it("keeps mirroring a session that left its pane, and says what happened", async () => {
    // Latched on purpose. Dropping the flag would swap the whole band out from under whoever was
    // mid-sentence and take their draft with it, explaining nothing; this keeps the field where
    // it is and lets the reason be read.
    const feed = pane("hello");
    render(<Probe feed={feed} />);
    await settle();
    expect(screen.getByTestId("mirrored").textContent).toBe("true");
    await act(async () => {
      feed.emit({ text: null, hint: null, reason: "no-pane", exact: true, commands: [], pastes: [], images: [] });
    });
    expect(screen.getByTestId("mirrored").textContent).toBe("true");
    expect(screen.getByTestId("reason").textContent).toBe("no-pane");
    expect(draft()).toBe("hello");
  });

  it("never claims a session whose first word is that it has no pane", async () => {
    const feed = pane("", { text: null, hint: null, reason: "no-pane", exact: true, commands: [], pastes: [], images: [] });
    render(<Probe feed={feed} />);
    await settle();
    expect(screen.getByTestId("mirrored").textContent).toBe("false");
    expect(screen.getByTestId("reason").textContent).toBe("no-pane");
  });

  it("stays inert for a source it does not mirror, and subscribes to nothing", async () => {
    const feed = pane("hello");
    const { unmount } = render(<Probe feed={feed} active={false} />);
    await settle(2000);
    expect(feed.subscribes).toBe(0);
    expect(screen.getByTestId("mirrored").textContent).toBe("false");
    unmount();
  });

  it("offers Claude's suggestion as a placeholder, and stops once anything is typed", async () => {
    // A placeholder because that is exactly what it is: shown in the empty box, taking no part in
    // the value, gone the moment the reader types. Pushing it would type Claude's own guess into
    // the session as if somebody had meant it.
    const feed = pane("", { text: "", hint: "stop adding the three suggestions", reason: null, exact: true, commands: [], pastes: [], images: [] });
    render(<Probe feed={feed} />);
    await settle();
    expect(screen.getByTestId("hint").textContent).toBe("stop adding the three suggestions");
    expect(draft()).toBe("");
    expect(screen.getByLabelText("composer").getAttribute("placeholder"))
      .toBe("stop adding the three suggestions");

    await type("something of my own");
    expect(screen.getByTestId("hint").textContent).toBe("-");
    await settle(200);
    // And the suggestion never reaches the pane: only what was typed does.
    expect(feed.pushes).toEqual(["something of my own"]);
  });

  it("accepts the suggestion by pressing Tab in the pane, not by typing its words", async () => {
    // What accepting means belongs to Claude. The pane redraws with the words in it and the
    // stream reports that, which is why nothing here guesses at the result.
    const feed = pane("", { text: "", hint: "stop adding the three suggestions", reason: null, exact: true, commands: [], pastes: [], images: [] });
    render(<Probe feed={feed} />);
    await settle();
    await act(async () => { screen.getByText("accept").click(); });
    expect(feed.accepts).toBe(1);
    expect(feed.pushes).toEqual([]);

    // The pane comes back holding it, and the field adopts it because nothing was typed here.
    feed.box = "stop adding the three suggestions";
    await act(async () => { feed.announce(); });
    expect(draft()).toBe("stop adding the three suggestions");
  });

  it("shows the footer's mode and asks the sidecar for a chosen one, keeping the rail's latch", async () => {
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await act(async () => { feed.announceMode("auto"); });
    expect(screen.getByTestId("mode").textContent).toBe("auto");

    // An armed Ctrl is the reader's, for their next rail key, and the mode control must not spend it.
    await act(async () => { screen.getByText("ctrl").click(); });
    await press("choose-plan");
    expect(feed.modes).toEqual(["plan"]);
    expect(feed.keys).toEqual([]);
    expect(screen.getByTestId("modifiers").textContent).toContain("ctrl:armed");
    // The sidecar's answer is where the footer ended up, taken without waiting for the stream.
    expect(screen.getByTestId("mode").textContent).toBe("plan");
  });

  it("says why a mode could not be reached, and shows where the footer is", async () => {
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await act(async () => { feed.announceMode("auto"); });
    feed.modeAnswer = {
      ok: false,
      reason: "unreachable",
      message: "this session's Shift+Tab goes auto, plan and never reaches plan",
      mode: "acceptEdits",
    };
    await press("choose-plan");
    expect(screen.getByTestId("mode").textContent).toBe("acceptEdits");
    expect(screen.getByTestId("error").textContent).toContain("never reaches plan");
  });

  it("sends the draft before the images, so typed text never lands after them", async () => {
    // A drop appends to whatever the box holds, and text still sitting in the debounce has not
    // reached the box yet. Sent in the wrong order it would arrive after the image.
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await type("look at this");
    await press("drop");
    expect(feed.pushes).toEqual(["look at this"]);
    // One at a time and in order, because the pane numbers them in the order they arrive.
    expect(feed.drops).toEqual([1, 2]);
  });

  it("lets the pane's reading win after a drop, since it is not what was sent", async () => {
    // Claude replaces the path with its own `[Image #1]`, so the field cannot be filled from
    // anything this side knows. The guard that protects a draft from a stale reading has to come
    // off, or the field would sit showing the text that was typed before the drop.
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await type("look at this");
    await press("drop");
    await act(async () => { feed.emit(holding("look at this [Image #1] [Image #2]")); });
    expect(draft()).toBe("look at this [Image #1] [Image #2]");
  });

  it("does not send an image to a session whose pane has gone", async () => {
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    feed.syncTmuxComposer = async () => ({
      text: null, hint: null, reason: "no-pane", exact: true, commands: [], pastes: [], images: [],
    });
    await type("look at this");
    await press("drop");
    expect(feed.drops).toEqual([]);
    expect(screen.getByTestId("reason").textContent).toBe("no-pane");
  });

  it("lets the stream go when the band does", async () => {
    const feed = pane("hello");
    const { unmount } = render(<Probe feed={feed} />);
    await settle();
    expect(feed.live).toBe(true);
    unmount();
    expect(feed.live).toBe(false);
  });

  it("flushes an unsent edit when the field is left, rather than losing the debounce", async () => {
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    await type("typed then left");
    await act(async () => {
      fireEvent.blur(screen.getByLabelText("composer"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(feed.box).toBe("typed then left");
  });
});
