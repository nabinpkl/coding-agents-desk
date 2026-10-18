// A paste into the far desktop: held in an editable strip where the viewer has a keyboard deck to
// edit it with, and sent straight out where it has none. Split from the viewer's main suite, which
// covers its dock, keyboard and stream.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import { DesktopViewer } from "@/features/desktop-viewer/DesktopViewer";
import type { DesktopControlEvent, DesktopControlInput } from "@agentdesk/agent-feed-wire";
import { stubDeckLayout } from "@/features/desktop-viewer/keyboard-deck/keyboardDeckTestLayout";

const tileMock = vi.hoisted(() => ({
  publishSource: true,
  controlVersion: 2,
  navigation: false,
  emit: null as ((event: DesktopControlEvent) => void) | null,
  sent: [] as DesktopControlInput[],
}));

vi.mock("@/features/desktop-viewer/tile-stream/TileStreamRtc", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("@/features/desktop-viewer/tile-stream/TileStreamRtc")>();
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

describe("DesktopViewer paste", () => {

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
});
