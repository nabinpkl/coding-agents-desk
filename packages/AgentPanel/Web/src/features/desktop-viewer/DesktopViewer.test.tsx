import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentHttpTransport } from "../activity-feed/transport/AgentHttpTransport";
import { desktopDocumentFallbackHeight, DesktopViewer } from "./DesktopViewer";
import type { DesktopControlEvent, DesktopControlInput } from "@agentdesk/agent-feed-wire";
import { stubDeckLayout } from "./keyboardDeckTestLayout";

const tileMock = vi.hoisted(() => ({
  publishSource: true,
  controlVersion: 2,
  navigation: false,
  emit: null as ((event: DesktopControlEvent) => void) | null,
  sent: [] as DesktopControlInput[],
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
          tileMock.sent.push(input);
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

/** jsdom has no ResizeObserver, and the dock, the accessory and the tile frame all watch one. */
const observed = new Map<Element, () => void>();
const disconnected = vi.fn();

beforeEach(() => {
  tileMock.navigation = false;
  tileMock.emit = null;
  tileMock.sent = [];
  observed.clear();
  disconnected.mockClear();
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) {}
    observe(element: Element) { observed.set(element, this.callback); }
    disconnect() { disconnected(); }
  });
  localStorage.clear();
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

describe("DesktopViewer", () => {
  it("composes navigation, input controls and stream status in one measured dock", async () => {
    tileMock.publishSource = true;
    tileMock.controlVersion = 2;
    tileMock.navigation = true;
    const { container, unmount } = render(<DesktopViewer transport={transport()} />);
    const dock = await screen.findByTestId("desktop-bottom-chrome");
    expect(within(dock).getByRole("button", { name: "Desktop 8" })).toBeInTheDocument();
    expect(within(dock).getByRole("group", { name: "Desktop input controls" })).toBeInTheDocument();
    expect(within(dock).getByLabelText("Desktop stream status")).toHaveTextContent("1800×1169");
    const rect = vi.spyOn(dock, "getBoundingClientRect").mockReturnValue({ height: 120 } as DOMRect);
    act(() => observed.get(dock)!());
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
    act(() => observed.get(dock)!());
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

  it("draws its own keyboard where the browser would raise one, and focuses nothing", async () => {
    const media = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query === "(hover: none) and (pointer: coarse)",
      media: query, onchange: null, addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }) as MediaQueryList);
    try {
      tileMock.publishSource = true;
      tileMock.controlVersion = 2;
      render(<DesktopViewer transport={transport()} />);
      const show = await screen.findByRole("button", { name: "Keyboard" });
      await waitFor(() => expect(show).toBeEnabled());
      fireEvent.click(show);
      const deck = screen.getByTestId("keyboard-deck");
      expect(within(deck).getAllByRole("button")).toHaveLength(32);
      // The deck resolves touches by coordinates, so it needs the layout jsdom will not compute.
      stubDeckLayout(deck);
      // Nothing focused is the point: a focused field is what WebKit draws its form strip over.
      expect(document.activeElement).toBe(document.body);
      const q = screen.getByTestId("deck-key-char-71").getBoundingClientRect();
      const at = { pointerId: 1, clientX: (q.left + q.right) / 2, clientY: (q.top + q.bottom) / 2 };
      fireEvent.pointerDown(deck, at);
      fireEvent.pointerUp(deck, at);
      expect(document.activeElement).toBe(document.body);
      // Masked, because a manually shown keyboard has no focus result yet and an unknown field is
      // treated as secure. What it proves is that the deck's press reached the send path at all.
      expect(screen.getByLabelText("Local typing echo")).toHaveTextContent("•");
    } finally {
      media.mockRestore();
    }
  });

  it("switches between the panel's keyboard and the browser's, and back", async () => {
    const media = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query === "(hover: none) and (pointer: coarse)",
      media: query, onchange: null, addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }) as MediaQueryList);
    try {
      tileMock.publishSource = true;
      tileMock.controlVersion = 2;
      render(<DesktopViewer transport={transport()} />);
      const show = await screen.findByRole("button", { name: "Keyboard" });
      await waitFor(() => expect(show).toBeEnabled());
      fireEvent.click(show);
      const capture = screen.getByLabelText("Remote Mac keyboard input");
      const deck = screen.getByTestId("keyboard-deck");
      stubDeckLayout(deck);
      expect(document.activeElement).toBe(document.body);
      expect(screen.queryByRole("button", { name: "Switch to the panel keyboard" })).toBeNull();

      // The key in the globe's seat hands typing to WebKit, which needs the focus to happen
      // inside the tap itself.
      const native = screen.getByTestId("deck-key-native").getBoundingClientRect();
      const at = {
        pointerId: 1,
        clientX: (native.left + native.right) / 2,
        clientY: (native.top + native.bottom) / 2,
      };
      fireEvent.pointerDown(deck, at);
      fireEvent.pointerUp(deck, at);
      expect(screen.queryByTestId("keyboard-deck")).toBeNull();
      expect(document.activeElement).toBe(capture);

      fireEvent.click(screen.getByRole("button", { name: "Switch to the panel keyboard" }));
      expect(screen.getByTestId("keyboard-deck")).toBeInTheDocument();
      expect(document.activeElement).not.toBe(capture);
      // The blur that switching back causes must not read as the keyboard being dismissed, which
      // is decided a tick later and would otherwise tear the whole strip down.
      await act(() => new Promise((resolve) => { setTimeout(resolve, 1); }));
      expect(screen.getByTestId("keyboard-deck")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Remote keyboard controls" })).toBeInTheDocument();
    } finally {
      window.localStorage.removeItem("agentdesk.desktop-keyboard-mode.v1");
      media.mockRestore();
    }
  });

  it("holds a paste in an editable strip until it is sent", async () => {
    const media = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query === "(hover: none) and (pointer: coarse)",
      media: query, onchange: null, addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }) as MediaQueryList);
    const clipboard = { readText: vi.fn().mockResolvedValue("ls -la") };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    try {
      tileMock.publishSource = true;
      tileMock.controlVersion = 2;
      render(<DesktopViewer transport={transport()} />);
      const show = await screen.findByRole("button", { name: "Keyboard" });
      await waitFor(() => expect(show).toBeEnabled());
      fireEvent.click(show);
      const deck = screen.getByTestId("keyboard-deck");
      stubDeckLayout(deck);
      const typeOnDeck = (id: string) => {
        const box = screen.getByTestId(`deck-key-${id}`).getBoundingClientRect();
        const at = {
          pointerId: 1,
          clientX: (box.left + box.right) / 2,
          clientY: (box.top + box.bottom) / 2,
        };
        fireEvent.pointerDown(deck, at);
        fireEvent.pointerUp(deck, at);
      };

      // The paste opens a draft instead of going, because there is a keyboard here to edit it.
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Paste" })); });
      const strip = screen.getByRole("textbox", { name: "Pasted text, editable before sending" });
      expect(strip).toHaveTextContent("ls -la");
      expect(tileMock.sent.some((input) => input.type === "text")).toBe(false);
      // A field in look only: focusing one is what raises WebKit's keyboard.
      expect(strip).not.toHaveAttribute("contenteditable");
      expect(strip).not.toHaveAttribute("tabindex");

      // The deck edits it, and nothing reaches the Mac while it does.
      typeOnDeck("delete");
      typeOnDeck("char-72");
      expect(strip).toHaveTextContent("ls -lr");
      expect(tileMock.sent.filter((input) => input.type === "key-batch")).toEqual([]);

      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      expect(tileMock.sent.filter((input) => input.type === "text"))
        .toEqual([{ type: "text", sequence: 1, text: "ls -lr" }]);
      // Sent and gone: the strip is back to echoing what goes live.
      expect(screen.queryByRole("textbox", { name: "Pasted text, editable before sending" }))
        .toBeNull();
      typeOnDeck("char-71");
      expect(tileMock.sent.filter((input) => input.type === "key-batch")).toHaveLength(1);

      // Return is the other way out, and Cancel is the way out that sends nothing.
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Paste" })); });
      typeOnDeck("return");
      expect(tileMock.sent.filter((input) => input.type === "text")).toHaveLength(2);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Paste" })); });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("textbox", { name: "Pasted text, editable before sending" }))
        .toBeNull();
      expect(tileMock.sent.filter((input) => input.type === "text")).toHaveLength(2);
    } finally {
      media.mockRestore();
    }
  });

  it("sends a paste straight out where there is no deck to edit it with", async () => {
    const clipboard = { readText: vi.fn().mockResolvedValue("hello") };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    tileMock.publishSource = true;
    tileMock.controlVersion = 2;
    render(<DesktopViewer transport={transport()} />);
    const show = await screen.findByRole("button", { name: "Keyboard" });
    await waitFor(() => expect(show).toBeEnabled());
    fireEvent.click(show);
    // No deck on this surface, so there is nothing to edit a paste with and it goes as it always
    // did, without a draft in the way.
    expect(screen.queryByTestId("keyboard-deck")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Paste" })); });
    expect(tileMock.sent.filter((input) => input.type === "text"))
      .toEqual([{ type: "text", sequence: 1, text: "hello" }]);
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
    // Twelve rail-and-chrome controls plus Paste, and no deck: this browser reports a physical
    // keyboard, so the capture is focused and text arrives through it. The capture stays a 4x4
    // nothing in the corner because a field big enough to tap is what makes WebKit draw its form
    // strip over the key rail.
    expect(within(chrome).getAllByRole("button")).toHaveLength(13);
    expect(screen.queryByTestId("keyboard-deck")).toBeNull();
    expect(within(chrome).getByRole("button", { name: "Paste" })).toBeVisible();
    const rail = within(chrome).getByLabelText("Remote key rail");
    expect(within(rail).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Esc", "Tab", "⇧", "↑", "←", "↓", "→", "Cmd", "Ctrl", "Opt"]);
    expect(within(chrome).getByLabelText("Acknowledged remote input")).toHaveClass("sr-only");
    expect(within(chrome).getByLabelText("Input delivery")).toHaveClass("sr-only");
    expect(within(chrome).queryByText("Local echo above; delivery confirmed here")).not.toBeInTheDocument();
    expect(rail).not.toContainElement(within(chrome).getByRole("button", { name: "Hide" }));
    expect(rail).not.toContainElement(within(chrome).getByRole("button", { name: "Auto keyboard" }));
    for (const name of ["Esc", "Tab", "Shift modifier", "Cmd", "Ctrl", "Opt", "Hide"]) {
      expect(within(chrome).getByRole("button", { name })).toBeVisible();
    }
    fireEvent.pointerDown(within(chrome).getByRole("button", { name: "Shift modifier" }));
    fireEvent.click(within(chrome).getByRole("button", { name: "Shift modifier" }));
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

  it("ends the video where the keyboard accessory begins", async () => {
    tileMock.publishSource = true;
    tileMock.controlVersion = 2;
    render(<DesktopViewer transport={transport()} />);
    const box = screen.getByTestId("desktop-video-box");
    expect(box).toHaveStyle({ bottom: "0px" });

    const show = await screen.findByRole("button", { name: "Keyboard" });
    await waitFor(() => expect(show).toBeEnabled());
    fireEvent.click(show);

    const accessory = screen.getByRole("region", { name: "Remote keyboard controls" });
    vi.spyOn(accessory, "getBoundingClientRect").mockReturnValue({ height: 80 } as DOMRect);
    act(() => observed.get(accessory)!());
    expect(box).toHaveStyle({ bottom: "80px" });

    fireEvent.click(within(accessory).getByRole("button", { name: "Hide" }));
    expect(box).toHaveStyle({ bottom: "0px" });
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
