import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { AgentHttpTransport } from "../activity-feed/transport/AgentHttpTransport";
import { DesktopViewer } from "./DesktopViewer";

vi.mock("./TileStreamRtc", async () => {
  const React = await import("react");
  return {
    TileStreamRtc: ({ onState, onPointerTransport }: {
      onState?: (state: unknown) => void;
      onPointerTransport?: (transport: { send: () => boolean }) => void;
    }) => {
      React.useEffect(() => {
        onState?.({ kind: "playing", codec: "webrtc/h264", firstFrameMs: 12 });
        onPointerTransport?.({ send: () => true });
      }, [onPointerTransport, onState]);
      return <div data-testid="desktop-video" />;
    },
  };
});

function transport(response: { status: number; body: string }): AgentHttpTransport {
  return {
    request: vi.fn().mockResolvedValue(response),
    subscribe: vi.fn(),
  };
}

describe("DesktopViewer", () => {
  it("loads only active-display metadata and opens the whole desktop stream", async () => {
    const http = transport({
      status: 200,
      body: JSON.stringify({ display: { index: 1, frame: { x: 0, y: 0, w: 1800, h: 1169 } } }),
    });

    render(<DesktopViewer transport={http} />);

    expect(await screen.findByTestId("desktop-video")).toBeInTheDocument();
    expect(http.request).toHaveBeenCalledWith(
      "GET",
      "/api/desktop/display",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.queryByText(/park|window/i)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Pointer" })).toBeEnabled());
  });

  it("shows a retryable error instead of a blank viewer", async () => {
    render(<DesktopViewer transport={transport({
      status: 503,
      body: JSON.stringify({ message: "yabai reported no displays" }),
    })} />);

    expect(await screen.findByText("yabai reported no displays")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("turns an invalid display response into a visible failure", async () => {
    render(<DesktopViewer transport={transport({ status: 200, body: "{}" })} />);

    expect(await screen.findByText("desktop display response was invalid")).toBeInTheDocument();
  });
});
