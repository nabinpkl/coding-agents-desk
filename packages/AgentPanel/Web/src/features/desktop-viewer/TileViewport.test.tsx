import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { WebrtcPointerInput } from "@agentdesk/agent-feed-wire";
import { TileViewport } from "./TileViewport";

describe("TileViewport pointer mode", () => {
  const animationFrames: FrameRequestCallback[] = [];

  afterEach(() => {
    animationFrames.length = 0;
    vi.restoreAllMocks();
  });

  function renderPointerSurface(send: (input: WebrtcPointerInput) => boolean) {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    render(
      <TileViewport pointerMode sendPointerInput={send}>
        <div data-testid="content" />
      </TileViewport>,
    );
    return screen.getByTestId("content").parentElement!.parentElement!;
  }

  function pointer(
    surface: HTMLElement,
    type: "pointerdown" | "pointermove" | "pointerup",
    pointerId: number,
    clientX: number,
    clientY: number,
  ) {
    const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    surface.dispatchEvent(event);
  }

  it("moves the existing pointer relatively and does not turn a drag into a click", () => {
    const inputs: WebrtcPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });

    pointer(surface, "pointerdown", 1, 10, 10);
    pointer(surface, "pointermove", 1, 18, 14);
    act(() => animationFrames.shift()?.(performance.now() + 16));
    pointer(surface, "pointerup", 1, 18, 14);

    const move = inputs.find((input) => input.t === "move");
    expect(move).toMatchObject({ t: "move" });
    if (move?.t === "move") {
      expect(move.dx).toBeGreaterThan(0);
      expect(move.dy).toBeGreaterThan(0);
    }
    expect(inputs.some((input) => input.t === "click")).toBe(false);
  });

  it("clicks at the parked cursor for a tap", () => {
    const inputs: WebrtcPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });

    pointer(surface, "pointerdown", 1, 80, 50);
    pointer(surface, "pointerup", 1, 80, 50);

    expect(inputs).toEqual([{ t: "click", button: "left" }]);
  });

  it("turns a two-finger centroid pan into a phased free-axis scroll", () => {
    const inputs: WebrtcPointerInput[] = [];
    const surface = renderPointerSurface((input) => {
      inputs.push(input);
      return true;
    });

    pointer(surface, "pointerdown", 1, 10, 10);
    pointer(surface, "pointerdown", 2, 30, 30);
    pointer(surface, "pointermove", 1, 16, 14);
    act(() => animationFrames.shift()?.(performance.now() + 16));
    pointer(surface, "pointerup", 2, 30, 30);
    pointer(surface, "pointerup", 1, 16, 14);

    expect(inputs[0]).toMatchObject({ t: "scroll", phase: "began" });
    expect(inputs.at(-1)).toEqual({ t: "scroll", dx: 0, dy: 0, phase: "ended" });
    expect(inputs.some((input) => input.t === "click")).toBe(false);
  });
});
