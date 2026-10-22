import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HereOutcome } from "@/features/audio-channel/playHere";

const playback = vi.hoisted(() => ({
  stop: vi.fn(),
  finish: (_outcome: HereOutcome) => {},
  texts: [] as string[],
}));

vi.mock("@/features/audio-channel/playHere", () => ({
  playHere: (text: string) => {
    playback.texts.push(text);
    return {
      stop: playback.stop,
      finished: new Promise<HereOutcome>((resolve) => (playback.finish = resolve)),
    };
  },
}));

const { SpeakHereButton } = await import("@/features/audio-channel/SpeakHereButton");

afterEach(() => {
  playback.stop.mockReset();
  playback.texts.length = 0;
});

describe("the speaker on a reply", () => {
  it("plays on a tap, stops on the next, and plays from the top on the one after", async () => {
    render(<SpeakHereButton text="It works now." />);
    fireEvent.click(screen.getByRole("button", { name: "Play on this device" }));
    expect(playback.texts).toEqual(["It works now."]);
    fireEvent.click(screen.getByRole("button", { name: "Stop playing" }));
    expect(playback.stop).toHaveBeenCalledTimes(1);
    // The stopped playback answering late does not bring the stop button back.
    playback.finish({ state: "stopped" });
    expect(await screen.findByRole("button", { name: "Play on this device" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Play on this device" }));
    expect(playback.texts).toHaveLength(2);
  });

  it("goes back to its speaker once it has played, and says so in words when it could not", async () => {
    render(<SpeakHereButton text="Hi." />);
    fireEvent.click(screen.getByRole("button", { name: "Play on this device" }));
    playback.finish({ state: "played" });
    expect(await screen.findByRole("button", { name: "Play on this device" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Play on this device" }));
    playback.finish({ state: "failed", reason: "the sidecar answered 502" });
    expect(await screen.findByText("Could not play it")).toBeInTheDocument();
  });
});
