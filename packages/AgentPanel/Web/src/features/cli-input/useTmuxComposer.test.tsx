import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { TmuxComposerState } from "@agentdesk/agent-feed-wire";
import type { SessionAddress } from "../activity-feed/data-source/SidecarDataSource";
import { useTmuxComposer } from "./useTmuxComposer";

const SESSION: SessionAddress = { source: "claude", sessionId: "s1" };

function holding(text: string, wrapped = false): TmuxComposerState {
  return { text, reason: null, wrapped };
}

/** A pane whose composer this test drives directly, standing in for the sidecar and tmux. */
function pane(initial = "") {
  const feed = {
    box: initial,
    reads: 0,
    pushes: [] as string[],
    submits: 0,
    wrapped: false,
    fail: null as string | null,
    readTmuxComposer: async (): Promise<TmuxComposerState> => {
      feed.reads += 1;
      if (feed.fail) return { text: null, reason: "no-pane", wrapped: false };
      return holding(feed.box, feed.wrapped);
    },
    syncTmuxComposer: async (_session: SessionAddress, text: string): Promise<TmuxComposerState> => {
      feed.pushes.push(text);
      if (feed.fail) return { text: null, reason: "no-pane", wrapped: false };
      feed.box = text;
      feed.wrapped = false;
      return holding(text);
    },
    submitTmuxComposer: async (): Promise<TmuxComposerState> => {
      feed.submits += 1;
      feed.box = "";
      return holding("");
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
      <input
        aria-label="composer"
        value={composer.draft}
        onChange={(event) => composer.change(event.target.value)}
        onBlur={composer.onBlur}
      />
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
    const feed = pane("make the hover ring stronger");
    render(<Probe feed={feed} />);
    await settle();
    expect(draft()).toBe("make the hover ring stronger");
    expect(screen.getByTestId("mirrored").textContent).toBe("true");
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

  it("does not let a poll overwrite an edit that has not reached the pane yet", async () => {
    const feed = pane("");
    render(<Probe feed={feed} />);
    await settle();
    // Somebody else typed into the pane at the same moment as this reader typed here. The reader's
    // own text is newer than anything a screen can show, so the poll must leave it alone.
    await type("mine");
    feed.box = "theirs";
    await settle(50);
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
    await settle(900);
    expect(draft()).toBe("typed in the pane itself");
  });

  it("will not overwrite a draft with a reading it cannot trust to the character", async () => {
    // A wrapped composer is reconstructed by guessing the space the wrap consumed. Filling an
    // empty field with a guess costs nothing; replacing typed text with one loses a character.
    const feed = pane("alpha bravo charlie");
    feed.wrapped = true;
    render(<Probe feed={feed} />);
    await settle();
    expect(draft()).toBe("alpha bravo charlie");

    const second = pane("alpha bravo charlie");
    second.wrapped = true;
    render(<Probe feed={second} />);
    await settle();
    await type("something the reader typed", 1);
    await settle(2000);
    expect(screen.getAllByTestId("draft")[1]!.textContent).toBe("something the reader typed");
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
    feed.fail = "gone";
    await settle(900);
    expect(screen.getByTestId("mirrored").textContent).toBe("true");
    expect(screen.getByTestId("reason").textContent).toBe("no-pane");
    expect(draft()).toBe("hello");
  });

  it("never claims a session that has no pane at all", async () => {
    const feed = pane("");
    feed.fail = "gone";
    render(<Probe feed={feed} />);
    await settle(900);
    expect(screen.getByTestId("mirrored").textContent).toBe("false");
    expect(screen.getByTestId("reason").textContent).toBe("no-pane");
  });

  it("stays inert for a session that is not a terminal one, and polls nothing", async () => {
    const feed = pane("hello");
    render(<Probe feed={feed} active={false} />);
    await settle(2000);
    expect(feed.reads).toBe(0);
    expect(screen.getByTestId("mirrored").textContent).toBe("false");
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
