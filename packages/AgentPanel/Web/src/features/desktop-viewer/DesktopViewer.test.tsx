import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { AgentHttpTransport } from "../activity-feed/transport/AgentHttpTransport";
import { desktopDocumentFallbackHeight, DesktopViewer } from "./DesktopViewer";

const tileMock = vi.hoisted(() => ({ publishSource: true, controlVersion: 2 }));

vi.mock("./TileStreamRtc", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("./TileStreamRtc")>();
  return {
    ...actual,
    TileStreamRtc: ({ onState, onControlTransport, onSourceMetadata }: {
      onState?: (state: unknown) => void;
      onControlTransport?: (transport: { send: () => "sent" }) => void;
      onSourceMetadata?: (metadata: unknown) => void;
    }) => {
      React.useEffect(() => {
        if (tileMock.publishSource) {
          onSourceMetadata?.({
            width: 1800,
            height: 1169,
            cursor: { x: 900, y: 584.5 },
            desktopControlVersion: tileMock.controlVersion,
          });
        }
        onState?.({ kind: "playing", codec: "webrtc/h264", firstFrameMs: 12 });
        onControlTransport?.({ send: () => "sent" });
      }, [onControlTransport, onSourceMetadata, onState]);
      return <div data-testid="desktop-video" />;
    },
  };
});

function transport(): AgentHttpTransport {
  return {
    request: vi.fn().mockResolvedValue({ status: 204, body: "" }),
    subscribe: vi.fn(),
  };
}

describe("DesktopViewer", () => {
  it("recovers a zero-height WebKit viewport from the physical CSS screen", () => {
    expect(desktopDocumentFallbackHeight(0, 956)).toBe(956);
    expect(desktopDocumentFallbackHeight(844, 956)).toBeNull();
    expect(desktopDocumentFallbackHeight(0, 0)).toBeNull();
  });

  it("gets source metadata from WebRTC without a display bootstrap request", async () => {
    tileMock.publishSource = true;
    tileMock.controlVersion = 2;
    const http = transport();

    render(<DesktopViewer transport={http} />);

    expect(await screen.findByTestId("desktop-video")).toBeInTheDocument();
    expect(screen.queryByText(/park|window/i)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Pointer" })).toBeEnabled());
    expect(http.request).not.toHaveBeenCalledWith("GET", expect.anything(), expect.anything());

    const surface = screen.getByTestId("desktop-video").parentElement!.parentElement!;
    const down = new MouseEvent("pointerdown", { bubbles: true, clientX: 80, clientY: 50 });
    Object.defineProperty(down, "pointerId", { value: 1 });
    const up = new MouseEvent("pointerup", { bubbles: true, clientX: 80, clientY: 50 });
    Object.defineProperty(up, "pointerId", { value: 1 });
    act(() => {
      surface.dispatchEvent(down);
      surface.dispatchEvent(up);
    });

    await waitFor(() => expect(http.request).toHaveBeenCalledWith(
      "POST",
      "/api/park/tile/display/webrtc/telemetry",
      { body: expect.objectContaining({
        phase: "viewport-gesture-end",
        detail: expect.stringContaining('"kind":"pointer"'),
      }) },
    ));
  });

  it("keeps pointer input disabled until WebRTC supplies source metadata", async () => {
    tileMock.publishSource = false;
    tileMock.controlVersion = 2;
    render(<DesktopViewer transport={transport()} />);

    expect(await screen.findByTestId("desktop-video")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Input connecting" })).toBeDisabled();
  });

  it("keeps video visible and disables control loudly on a capability mismatch", async () => {
    tileMock.publishSource = true;
    tileMock.controlVersion = 1;
    render(<DesktopViewer transport={transport()} />);

    expect(await screen.findByTestId("desktop-video")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Control v1 unsupported" })).toBeDisabled();
  });
});
