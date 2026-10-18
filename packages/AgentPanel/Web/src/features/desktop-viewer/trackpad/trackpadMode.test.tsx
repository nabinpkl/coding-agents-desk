// Trackpad mode on the whole viewer: offered to a touch device, the deck under the picture, the
// picture only looked at while it is up, and the keyboard taking the deck away while it types.
//
// Its own file rather than a section of `DesktopViewer.test.tsx` because that one is at the
// line cap; the stream is stubbed the same way, smaller, since nothing here needs navigation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import { DesktopViewer } from "@/features/desktop-viewer/DesktopViewer";
import { useDeckHeight } from "@/features/desktop-viewer/trackpad/deckHeightPreference";
import type { DesktopControlInput } from "@agentdesk/agent-feed-wire";

const tileMock = vi.hoisted(() => ({
  publishSource: true,
  controlVersion: 2,
  sent: [] as DesktopControlInput[],
}));

vi.mock("@/features/desktop-viewer/tile-stream/TileStreamRtc", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("@/features/desktop-viewer/tile-stream/TileStreamRtc")>();
  return {
    ...actual,
    TileStreamRtc: ({
      onState,
      onControlTransport,
      onSourceMetadata,
    }: {
      onState?: (state: unknown) => void;
      onControlTransport?: (transport: { send: (input: DesktopControlInput) => "sent" }) => void;
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
        onControlTransport?.({
          send: (input) => {
            tileMock.sent.push(input);
            return "sent";
          },
        });
      }, [onControlTransport, onSourceMetadata, onState]);
      return <div data-testid="desktop-video" />;
    },
  };
});

beforeEach(() => {
  tileMock.sent = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  useDeckHeight.getState().resetDeckShare();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function transport(): AgentHttpTransport {
  return {
    request: vi.fn().mockResolvedValue({ status: 204, body: "" }),
    subscribe: vi.fn(),
  };
}

describe("DesktopViewer trackpad deck", () => {
  function coarsePointer(coarse: boolean) {
    return vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: coarse && query === "(pointer: coarse)",
          media: query,
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
  }

  it("offers the deck on a touch device, puts it under the picture, and gives it back to the keyboard", async () => {
    const media = coarsePointer(true);
    try {
      tileMock.publishSource = true;
      tileMock.controlVersion = 2;
      render(<DesktopViewer transport={transport()} />);
      const toggle = await screen.findByRole("button", { name: "Trackpad" });
      await waitFor(() => expect(toggle).toBeEnabled());
      // Follow is a mouse's, which a touch device's primary pointer is not.
      expect(screen.queryByRole("button", { name: "Follow" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("trackpad-deck")).not.toBeInTheDocument();
      const box = screen.getByTestId("desktop-video-box");
      const before = Number.parseFloat(box.style.bottom);

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      // A mode, not a toggle beside Pointer: the deck drives the pointer, so the picture does not.
      expect(screen.getByRole("button", { name: "Pointer" })).toHaveAttribute("aria-pressed", "false");
      const deck = screen.getByTestId("trackpad-deck");
      expect(Number.parseFloat(box.style.bottom)).toBe(before + Number.parseFloat(deck.style.height));
      expect(localStorage.getItem("agentdesk.desktop.trackpadDeck")).toBe("true");

      await waitFor(() => expect(screen.getByRole("button", { name: "Right click" })).toBeEnabled());
      tileMock.sent = [];
      fireEvent.click(screen.getByRole("button", { name: "Right click" }));
      expect(tileMock.sent).toContainEqual({ type: "click", button: "right" });

      fireEvent.click(screen.getByRole("button", { name: "Keyboard" }));
      expect(screen.queryByTestId("trackpad-deck")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Hide" }));
      expect(screen.getByTestId("trackpad-deck")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Pointer" }));
      expect(screen.queryByTestId("trackpad-deck")).not.toBeInTheDocument();
      expect(localStorage.getItem("agentdesk.desktop.trackpadDeck")).toBe("false");
    } finally {
      media.mockRestore();
    }
  });

  it("sizes the deck to the share of the viewer chosen in Tuning, and keeps that share", async () => {
    const media = coarsePointer(true);
    // jsdom lays nothing out, so give the viewer a height for the share to be a share of.
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 800 } as DOMRect);
    try {
      localStorage.setItem("agentdesk.desktop.trackpadDeck", "true");
      tileMock.publishSource = true;
      tileMock.controlVersion = 2;
      render(<DesktopViewer transport={transport()} />);
      const deck = await screen.findByTestId("trackpad-deck");
      const box = screen.getByTestId("desktop-video-box");
      expect(deck.style.height).toBe("304px");
      const before = Number.parseFloat(box.style.bottom);

      fireEvent.click(screen.getByRole("button", { name: "Tuning" }));
      const slider = screen.getByLabelText("Trackpad height");
      expect(slider).toHaveValue("0.38");
      fireEvent.change(slider, { target: { value: "0.5" } });
      expect(deck.style.height).toBe("400px");
      // The picture gives up exactly what the deck took.
      expect(Number.parseFloat(box.style.bottom)).toBe(before + 96);
      expect(screen.getByText("50%")).toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem("agentdesk.desktop.trackpadDeckHeight")!).state).toEqual({
        deckShare: 0.5,
      });

      fireEvent.click(screen.getByRole("button", { name: "Reset" }));
      expect(deck.style.height).toBe("304px");
    } finally {
      rect.mockRestore();
      media.mockRestore();
    }
  });

  it("keeps Follow and no deck where the primary pointer is a mouse", async () => {
    const media = coarsePointer(false);
    try {
      localStorage.setItem("agentdesk.desktop.trackpadDeck", "true");
      tileMock.publishSource = true;
      tileMock.controlVersion = 2;
      render(<DesktopViewer transport={transport()} />);
      expect(await screen.findByRole("button", { name: "Follow" })).toBeInTheDocument();
      expect(screen.queryByTestId("trackpad-deck")).not.toBeInTheDocument();
    } finally {
      media.mockRestore();
    }
  });

  it("pans the picture under a finger in Trackpad mode and sends the Mac nothing", async () => {
    const media = coarsePointer(true);
    try {
      localStorage.setItem("agentdesk.desktop.trackpadDeck", "true");
      tileMock.publishSource = true;
      tileMock.controlVersion = 2;
      render(<DesktopViewer transport={transport()} />);
      const toggle = await screen.findByRole("button", { name: "Trackpad" });
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      await waitFor(() => expect(screen.getByRole("button", { name: "Right click" })).toBeEnabled());
      expect(screen.queryByTestId("pointer-scroll-puck")).not.toBeInTheDocument();

      tileMock.sent = [];
      const picture = screen.getByTestId("desktop-video").closest("[data-desktop-viewport]")!;
      const at = (type: string, x: number, y: number) => {
        const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
        Object.defineProperty(event, "pointerId", { value: 1 });
        Object.defineProperty(event, "pointerType", { value: "touch" });
        act(() => {
          picture.dispatchEvent(event);
        });
      };
      at("pointerdown", 100, 100);
      at("pointermove", 160, 140);
      at("pointerup", 160, 140);
      at("pointerdown", 100, 100);
      at("pointerup", 100, 100);
      const pointerTypes = new Set(["pointer-move", "pointer-warp", "click", "mouse-down", "mouse-up", "scroll"]);
      expect(tileMock.sent.filter((input) => pointerTypes.has(input.type))).toEqual([]);
    } finally {
      media.mockRestore();
    }
  });
});
