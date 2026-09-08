import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { RailKey, RailModifiers, TmuxComposerState } from "@agentdesk/agent-feed-wire";
import type { SessionAddress } from "../activity-feed/data-source/SidecarDataSource";
import { useTmuxComposer } from "./useTmuxComposer";

const SESSION: SessionAddress = { source: "claude", sessionId: "s1" };

function holding(text: string, wrapped = false, hint: string | null = null): TmuxComposerState {
  return { text, hint, reason: null, exact: !wrapped, commands: [] };
}

/**
 * A pane whose composer this test drives directly, standing in for the sidecar and tmux.
 *
 * `emit` is what the sidecar's watcher does when the pane writes. Nothing is on a timer here for
 * the same reason nothing is in the hook: the pane speaks, or it does not.
 */
function pane(initial = "", opening?: TmuxComposerState) {
  let listener: ((state: TmuxComposerState) => void) | null = null;
  const feed = {
    box: initial,
    subscribes: 0,
    live: false,
    pushes: [] as string[],
    submits: 0,
    accepts: 0,
    /**
     * The size of each image handed over, in the order the pane would number them.
     *
     * Sizes rather than contents: reading a `Blob` is asynchronous in a way fake timers do not
     * drive, and what this test is about is which image arrives first.
     */
    drops: [] as number[],
    /** Sends one state to whoever is subscribed, as the pane writing would. */
    emit(state: TmuxComposerState) {
      listener?.(state);
    },
    /** Sends what the box now holds, which is the ordinary case. */
    announce(wrapped = false) {
      feed.emit(holding(feed.box, wrapped));
    },
    subscribeTmuxComposer(
      _session: SessionAddress,
      onState: (state: TmuxComposerState) => void,
    ): () => void {
      feed.subscribes += 1;
      feed.live = true;
      listener = onState;
      onState(opening ?? holding(feed.box));
      return () => {
        feed.live = false;
        listener = null;
      };
    },
    syncTmuxComposer: async (_session: SessionAddress, text: string): Promise<TmuxComposerState> => {
      feed.pushes.push(text);
      feed.box = text;
      return holding(text);
    },
    submitTmuxComposer: async (): Promise<TmuxComposerState> => {
      feed.submits += 1;
      feed.box = "";
      return holding("");
    },
    acceptTmuxComposerHint: async (): Promise<TmuxComposerState> => {
      feed.accepts += 1;
      return { text: null, hint: null, reason: null, exact: true, commands: [] };
    },
    /** Every rail press, so a test can ask what reached the pane and what was held when it did. */
    keys: [] as { key: RailKey; modifiers: RailModifiers }[],
    pressTmuxComposerKey: async (
      _session: SessionAddress,
      key: RailKey,
      modifiers: RailModifiers,
    ): Promise<TmuxComposerState> => {
      feed.keys.push({ key, modifiers });
      return { text: null, hint: null, reason: null, exact: true, commands: [] };
    },
    dropTmuxComposerImage: async (
      _session: SessionAddress,
      image: Blob,
    ): Promise<TmuxComposerState> => {
      feed.drops.push(image.size);
      return { text: null, hint: null, reason: null, exact: true, commands: [] };
    },
  };
  return feed;
}

function Probe({ feed, active = true }: { feed: ReturnType<typeof pane>; active?: boolean }) {
  const composer = useTmuxComposer(feed, SESSION, active);
  return (
    <div>
      <span data-testid="draft">{composer.draft}</span>
      <span data-testid="mirrored">{String(composer.mirrored)}</span>
      <span data-testid="reason">{composer.reason ?? "-"}</span>
      <span data-testid="hint">{composer.hint ?? "-"}</span>
      <span data-testid="images">
        {composer.images.map((image) => `${image.id}:${image.url ?? "none"}`).join(" ")}
      </span>
      <input
        aria-label="composer"
        value={composer.draft}
        onChange={(event) => composer.change(event.target.value)}
        onBlur={composer.onBlur}
        placeholder={composer.hint ?? "Type into Claude's terminal…"}
      />
      <button type="button" onClick={() => void composer.accept()}>accept</button>
      <span data-testid="modifiers">
        {(["ctrl", "alt", "shift"] as const).map((m) => `${m}:${composer.modifiers[m]}`).join(" ")}
      </span>
      <button type="button" onClick={() => composer.toggleModifier("ctrl")}>ctrl</button>
      <button type="button" onClick={() => composer.pressKey("escape")}>escape</button>
      <button type="button" onClick={() => composer.pressKey("left")}>left</button>
      <button type="button" onClick={() => composer.remove(7)}>remove</button>
      <span data-testid="commands">
        {composer.commands.map((c) => `${c.selected ? ">" : ""}${c.name}`).join(" ")}
      </span>
      <button type="button" onClick={() => composer.chooseCommand("/rename")}>choose</button>
      <button
        type="button"
        // Two images of different sizes, which is how the test tells them apart in order.
        onClick={() => void composer.drop([new Blob(["1"]), new Blob(["22"])])}
      >
        drop
      </button>
      <button type="button" onClick={() => void composer.submit()}>send</button>
    </div>
  );
}

/**
 * One keystroke's worth of typing into the field.
 *
 * `fireEvent.change` rather than a hand-dispatched input event: React tracks a controlled input's
 * value itself, and assigning to `.value` updates that tracker, so the change it is meant to
 * announce is the one React then decides did not happen.
 */
async function type(value: string, which = 0) {
  await act(async () => {
    fireEvent.change(screen.getAllByLabelText("composer")[which]!, { target: { value } });
  });
}

/** Lets every pending promise settle, and any timer shorter than `ms` fire. */
async function settle(ms = 0) {
  await act(async () => {
    if (ms > 0) vi.advanceTimersByTime(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
}

/**
 * Clicks a button and lets the chain of awaits behind it finish.
 *
 * More than one flush because a drop is a sequence of round trips rather than one: the draft,
 * then each image, each of which reads its own bytes. A single flush leaves it half done.
 */
async function press(label: string) {
  await act(async () => {
    screen.getByText(label).click();
    for (let flush = 0; flush < 8; flush += 1) await vi.advanceTimersByTimeAsync(0);
  });
}


const draft = () => screen.getByTestId("draft").textContent;

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
    expect(feed.subscribes).toBe(1);
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

  it("keeps mirroring a session that left its pane, and says what happened", async () => {
    // Latched on purpose. Dropping the flag would swap the whole band out from under whoever was
    // mid-sentence and take their draft with it, explaining nothing; this keeps the field where
    // it is and lets the reason be read.
    const feed = pane("hello");
    render(<Probe feed={feed} />);
    await settle();
    expect(screen.getByTestId("mirrored").textContent).toBe("true");
    await act(async () => {
      feed.emit({ text: null, hint: null, reason: "no-pane", exact: true, commands: [] });
    });
    expect(screen.getByTestId("mirrored").textContent).toBe("true");
    expect(screen.getByTestId("reason").textContent).toBe("no-pane");
    expect(draft()).toBe("hello");
  });

  it("never claims a session whose first word is that it has no pane", async () => {
    const feed = pane("", { text: null, hint: null, reason: "no-pane", exact: true, commands: [] });
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
    const feed = pane("", { text: "", hint: "stop adding the three suggestions", reason: null, exact: true, commands: [] });
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
    const feed = pane("", { text: "", hint: "stop adding the three suggestions", reason: null, exact: true, commands: [] });
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
      text: null, hint: null, reason: "no-pane", exact: true, commands: [],
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
        commands: [],
      });
    });
    expect(screen.getByTestId("draft").textContent).toBe("/rename ");
  });
});

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
