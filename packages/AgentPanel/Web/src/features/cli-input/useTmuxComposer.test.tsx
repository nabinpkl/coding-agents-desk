import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { TmuxComposerState } from "@agentdesk/agent-feed-wire";
import type { SessionAddress } from "../activity-feed/data-source/SidecarDataSource";
import { useTmuxComposer } from "./useTmuxComposer";

const SESSION: SessionAddress = { source: "claude", sessionId: "s1" };

function holding(text: string, wrapped = false, hint: string | null = null): TmuxComposerState {
  return { text, hint, reason: null, wrapped };
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
      return { text: null, hint: null, reason: null, wrapped: false };
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
      <input
        aria-label="composer"
        value={composer.draft}
        onChange={(event) => composer.change(event.target.value)}
        onBlur={composer.onBlur}
        placeholder={composer.hint ?? "Type into Claude's terminal…"}
      />
      <button type="button" onClick={() => void composer.accept()}>accept</button>
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
      feed.emit({ text: null, hint: null, reason: "no-pane", wrapped: false });
    });
    expect(screen.getByTestId("mirrored").textContent).toBe("true");
    expect(screen.getByTestId("reason").textContent).toBe("no-pane");
    expect(draft()).toBe("hello");
  });

  it("never claims a session whose first word is that it has no pane", async () => {
    const feed = pane("", { text: null, hint: null, reason: "no-pane", wrapped: false });
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
    const feed = pane("", { text: "", hint: "stop adding the three suggestions", reason: null, wrapped: false });
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
    const feed = pane("", { text: "", hint: "stop adding the three suggestions", reason: null, wrapped: false });
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
