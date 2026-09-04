import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentHttpTransport } from "../activity-feed/transport/AgentHttpTransport";
import { desktopDocumentFallbackHeight, DesktopViewer } from "./DesktopViewer";
import type { DesktopControlEvent, DesktopControlInput } from "@agentdesk/agent-feed-wire";

const tileMock = vi.hoisted(() => ({
  publishSource: true,
  controlVersion: 2,
  navigation: false,
  emit: null as ((event: DesktopControlEvent) => void) | null,
}));

vi.mock("./TileStreamRtc", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("./TileStreamRtc")>();
  return {
    ...actual,
    TileStreamRtc: ({ onState, onControlTransport, onSourceMetadata, onControlEvent }: {
      onState?: (state: unknown) => void;
      onControlTransport?: (transport: { send: (input: DesktopControlInput) => "sent" }) => void;
      onSourceMetadata?: (metadata: unknown) => void;
      onControlEvent?: (event: DesktopControlEvent) => void;
    }) => {
      React.useEffect(() => {
        tileMock.emit = (event: DesktopControlEvent) => onControlEvent?.(event);
        if (tileMock.publishSource) {
          onSourceMetadata?.({
            width: 1800,
            height: 1169,
            cursor: { x: 900, y: 584.5 },
            desktopControlVersion: tileMock.controlVersion,
            ...(tileMock.navigation ? { desktopNavigationVersion: 1, displayId: "A" } : {}),
          });
        }
        onState?.({ kind: "playing", codec: "webrtc/h264", firstFrameMs: 12 });
        onControlTransport?.({ send: (input) => {
          if (tileMock.navigation && input.type === "desktop-refresh") {
            onControlEvent?.({ type: "desktop-state", revision: 1, captureDisplayId: "A", displays: [{
              id: "A", label: "Main", isMain: true, activeSpaceId: "1",
              spaces: Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), type: 0 })),
            }] });
          }
          return "sent";
        } });
      }, [onControlTransport, onSourceMetadata, onState]);
      return <div data-testid="desktop-video" />;
    },
  };
});

beforeEach(() => {
  tileMock.navigation = false;
  tileMock.emit = null;
  localStorage.clear();
});

function transport(): AgentHttpTransport {
  return {
    request: vi.fn().mockResolvedValue({ status: 204, body: "" }),
    subscribe: vi.fn(),
  };
}

describe("DesktopViewer", () => {
  it("composes navigation, input controls and stream status in one measured dock", async () => {
    tileMock.publishSource = true;
    tileMock.controlVersion = 2;
    tileMock.navigation = true;
    const measurements = new Map<Element, () => void>();
    const disconnected = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: () => void) {}
      observe(element: Element) { measurements.set(element, this.callback); }
      disconnect() { disconnected(); }
    });
    const { container, unmount } = render(<DesktopViewer transport={transport()} />);
    const dock = await screen.findByTestId("desktop-bottom-chrome");
    expect(within(dock).getByRole("button", { name: "Desktop 8" })).toBeInTheDocument();
    expect(within(dock).getByRole("group", { name: "Desktop input controls" })).toBeInTheDocument();
    expect(within(dock).getByLabelText("Desktop stream status")).toHaveTextContent("1800×1169");
    const rect = vi.spyOn(dock, "getBoundingClientRect").mockReturnValue({ height: 120 } as DOMRect);
    act(() => measurements.get(dock)!());
    expect(container.firstElementChild).toHaveStyle({ "--desktop-chrome-clearance": "128px" });
    vi.useFakeTimers();
    try {
      fireEvent.click(within(dock).getByRole("button", { name: "Desktop 2" }));
      act(() => vi.advanceTimersByTime(2001));
      expect(within(dock).getByText("Desktop switch timed out")).toBeInTheDocument();
      expect(within(dock).getByRole("button", { name: "Keyboard" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
    rect.mockReturnValue({ height: 154 } as DOMRect);
    act(() => measurements.get(dock)!());
    expect(container.firstElementChild).toHaveStyle({ "--desktop-chrome-clearance": "162px" });

    fireEvent.click(within(dock).getByRole("button", { name: "Keyboard" }));
    expect(screen.queryByTestId("desktop-navigation")).not.toBeInTheDocument();
    expect(within(dock).queryByRole("group", { name: "Desktop input controls" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Remote keyboard controls" }).parentElement).toBe(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(within(dock).getByRole("button", { name: "Desktop 8" })).toBeInTheDocument();
    unmount();
    expect(disconnected).toHaveBeenCalled();
  });

  it("keeps the capture and every accessory control outside the clipped viewer toolbar", async () => {
    tileMock.publishSource = true;
    tileMock.controlVersion = 2;
    const { container } = render(<DesktopViewer transport={transport()} />);
    const show = await screen.findByRole("button", { name: "Keyboard" });
    await waitFor(() => expect(show).toBeEnabled());
    fireEvent.click(show);
    const chrome = screen.getByRole("region", { name: "Remote keyboard controls" });
    const capture = screen.getByLabelText("Remote Mac keyboard input");
    expect(chrome.parentElement).toBe(document.body);
    expect(capture.parentElement).toBe(document.body);
    expect(container).not.toContainElement(chrome);
    expect(capture).toHaveStyle({ fontSize: "16px" });
    expect(within(chrome).getAllByRole("button")).toHaveLength(12);
    const rail = within(chrome).getByLabelText("Remote key rail");
    expect(within(rail).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Esc", "Tab", "⇧", "↑", "←", "↓", "→", "Cmd", "Ctrl", "Opt"]);
    expect(within(chrome).getByLabelText("Acknowledged remote input")).toHaveClass("sr-only");
    expect(within(chrome).getByLabelText("Input delivery")).toHaveClass("sr-only");
    expect(within(chrome).queryByText("Local echo above; delivery confirmed here")).not.toBeInTheDocument();
    expect(rail).not.toContainElement(within(chrome).getByRole("button", { name: "Hide" }));
    expect(rail).not.toContainElement(within(chrome).getByRole("button", { name: "Auto keyboard" }));
    for (const name of ["Esc", "Tab", "Shift", "Cmd", "Ctrl", "Opt", "Hide"]) {
      expect(within(chrome).getByRole("button", { name })).toBeVisible();
    }
    fireEvent.pointerDown(within(chrome).getByRole("button", { name: "Shift" }));
    fireEvent.click(within(chrome).getByRole("button", { name: "Shift" }));
    expect(document.activeElement).toBe(capture);
    expect(chrome).toBeInTheDocument();
    fireEvent.click(within(chrome).getByRole("button", { name: "Hide" }));
    expect(chrome).not.toBeInTheDocument();
    expect(capture).toBeInTheDocument();
  });

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

  it("summons the keyboard from the mirrored cursor shape at the moment of the tap", async () => {
    tileMock.publishSource = true;
    tileMock.controlVersion = 2;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    render(<DesktopViewer transport={transport()} />);

    const video = await screen.findByTestId("desktop-video");
    const surface = video.parentElement!.parentElement!;
    Object.defineProperties(surface, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 500 },
    });
    const capture = screen.getByLabelText("Remote Mac keyboard input");
    const tap = () => act(() => {
      for (const type of ["pointerdown", "pointerup"] as const) {
        const event = new MouseEvent(type, { bubbles: true, clientX: 400, clientY: 250 });
        Object.defineProperty(event, "pointerId", { value: 1 });
        surface.dispatchEvent(event);
      }
    });
    const cursor = (cursorKind: "arrow" | "ibeam") => act(() => tileMock.emit!({
      type: "cursor-image", hash: cursorKind, hotspotXFrac: 0, hotspotYFrac: 0,
      widthPoints: 16, heightPoints: 16, hidden: false, cursorKind,
    }));

    cursor("arrow");
    tap();
    expect(document.activeElement).not.toBe(capture);

    // Read live, not captured at mount: the same surface, the same tap, one hover apart.
    cursor("ibeam");
    tap();
    expect(document.activeElement).toBe(capture);
  });
});
