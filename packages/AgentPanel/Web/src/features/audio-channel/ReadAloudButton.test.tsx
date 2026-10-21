import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadAloudButton } from "@/features/audio-channel/ReadAloudButton";
import { AgentReply } from "@/features/activity-feed/markdown/AgentReply";

function answer(status: number, body: unknown) {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the speaker on a reply", () => {
  it("reads on a tap, stops on the next, and reads from the top on the one after", async () => {
    let finish: (response: Response) => void = () => {};
    const fetch = vi.fn((url: string) =>
      url === "/api/speech/stop"
        ? Promise.resolve(new Response(null, { status: 204 }))
        : new Promise<Response>((resolve) => (finish = resolve)),
    );
    vi.stubGlobal("fetch", fetch);
    render(<ReadAloudButton text="It works now." />);
    fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/speech/read");
    expect(JSON.parse(String(init.body))).toEqual({ text: "It works now." });

    fireEvent.click(screen.getByRole("button", { name: "Stop reading" }));
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/speech/stop");
    // The stopped request answering late does not bring the stop back.
    finish(new Response(JSON.stringify({ error: { code: "stopped", message: "x" } }), { status: 409 }));
    expect(await screen.findByRole("button", { name: "Read aloud" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    expect(fetch.mock.calls[2]?.[0]).toBe("/api/speech/read");
    expect(screen.getByRole("button", { name: "Stop reading" })).toBeInTheDocument();
  });

  it("says so in words when nobody is listening", async () => {
    vi.stubGlobal("fetch", answer(409, { error: { code: "nobody_listening", message: "x", retryable: false } }));
    render(<ReadAloudButton text="Hi." />);
    fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    expect(await screen.findByText("Nobody is listening")).toBeInTheDocument();
  });

  it("ends a reply only once it has landed", () => {
    const { rerender } = render(<AgentReply content="Still typing" streaming />);
    expect(screen.queryByRole("button", { name: "Read aloud" })).toBeNull();
    rerender(<AgentReply content="Still typing, and done." />);
    expect(screen.getByRole("button", { name: "Read aloud" })).toBeInTheDocument();
  });
});
