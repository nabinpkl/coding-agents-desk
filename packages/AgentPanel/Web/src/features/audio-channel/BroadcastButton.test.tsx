import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BroadcastButton } from "@/features/audio-channel/BroadcastButton";
import { AgentReply } from "@/features/activity-feed/markdown/AgentReply";

function answer(status: number, body: unknown) {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the broadcast button on a reply", () => {
  it("reads on a tap, stops on the next, and reads from the top on the one after", async () => {
    let finish: (response: Response) => void = () => {};
    const fetch = vi.fn((url: string) =>
      url === "/api/speech/stop"
        ? Promise.resolve(new Response(null, { status: 204 }))
        : new Promise<Response>((resolve) => (finish = resolve)),
    );
    vi.stubGlobal("fetch", fetch);
    render(<BroadcastButton text="It works now." />);
    fireEvent.click(screen.getByRole("button", { name: "Broadcast to Agent Radio" }));
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/speech/read");
    expect(JSON.parse(String(init.body))).toEqual({ text: "It works now." });

    fireEvent.click(screen.getByRole("button", { name: "Stop broadcast" }));
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/speech/stop");
    // The stopped request answering late does not bring the stop back.
    finish(new Response(JSON.stringify({ error: { code: "stopped", message: "x" } }), { status: 409 }));
    expect(await screen.findByRole("button", { name: "Broadcast to Agent Radio" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Broadcast to Agent Radio" }));
    expect(fetch.mock.calls[2]?.[0]).toBe("/api/speech/read");
    expect(screen.getByRole("button", { name: "Stop broadcast" })).toBeInTheDocument();
  });

  it("says so in words when nobody is listening", async () => {
    vi.stubGlobal("fetch", answer(409, { error: { code: "nobody_listening", message: "x", retryable: false } }));
    render(<BroadcastButton text="Hi." />);
    fireEvent.click(screen.getByRole("button", { name: "Broadcast to Agent Radio" }));
    expect(await screen.findByText("Nobody is listening")).toBeInTheDocument();
  });

  it("ends a reply only once it has landed", () => {
    const { rerender } = render(<AgentReply content="Still typing" streaming />);
    expect(screen.queryByRole("button", { name: "Broadcast to Agent Radio" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Play on this device" })).toBeNull();
    rerender(<AgentReply content="Still typing, and done." />);
    expect(screen.getByRole("button", { name: "Broadcast to Agent Radio" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play on this device" })).toBeInTheDocument();
  });
});
