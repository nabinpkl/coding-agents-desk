import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DesktopNavigationChrome } from "@/features/desktop-viewer/DesktopNavigationChrome";
import { initialNavigationModel } from "@/features/desktop-viewer/desktopNavigationModel";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  HTMLElement.prototype.setPointerCapture = vi.fn();
});
function setup() {
  const callbacks = { onBegin: vi.fn(() => "id"), onMove: vi.fn(), onEnd: vi.fn(), onCancel: vi.fn(),
    onSelect: vi.fn(), onDisplay: vi.fn(), onRefresh: vi.fn() };
  render(<DesktopNavigationChrome model={initialNavigationModel} displayId="A" displays={[{
    id: "A", label: "Main", isMain: true, activeSpaceId: "1", spaces: [{ id: "1", type: 0 }, { id: "2", type: 0 }],
  }]} disabled={false} hidden={false} switching={false} {...callbacks} />);
  const button = screen.getByRole("button", { name: "Desktop 2" });
  const pointer = (type: string, id: number, x: number) => act(() => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x });
    Object.defineProperty(event, "pointerId", { value: id });
    button.dispatchEvent(event);
  });
  return { callbacks, button, pointer };
}
describe("desktop rail pointer arbitration", () => {
  it("selects once on a pointer tap and supports a keyboard click", () => {
    const { callbacks, button, pointer } = setup();
    pointer("pointerdown", 1, 40); pointer("pointerup", 1, 40);
    fireEvent.click(button, { detail: 1 });
    expect(callbacks.onSelect).toHaveBeenCalledExactlyOnceWith("2");
    fireEvent.click(button, { detail: 0 });
    expect(callbacks.onSelect).toHaveBeenCalledTimes(2);
  });
  it("starts at slop and cancels the entire multi-pointer sequence", () => {
    const { callbacks, pointer } = setup();
    pointer("pointerdown", 1, 40); pointer("pointermove", 1, 43);
    expect(callbacks.onBegin).not.toHaveBeenCalled();
    pointer("pointermove", 1, 50);
    expect(callbacks.onBegin).toHaveBeenCalledTimes(1);
    pointer("pointerdown", 2, 80); pointer("pointerdown", 3, 90);
    expect(HTMLElement.prototype.setPointerCapture).toHaveBeenCalledWith(2);
    pointer("pointermove", 3, 130);
    pointer("pointerup", 2, 80); pointer("pointerup", 1, 50); pointer("pointerup", 3, 130);
    expect(callbacks.onBegin).toHaveBeenCalledTimes(1);
    expect(callbacks.onCancel).toHaveBeenCalled();
    expect(callbacks.onEnd).not.toHaveBeenCalled();
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    pointer("pointerdown", 4, 40); pointer("pointerup", 4, 40);
    expect(callbacks.onSelect).toHaveBeenCalledExactlyOnceWith("2");
  });
  it("cancels lost capture without committing or producing a click", () => {
    const { callbacks, pointer } = setup();
    pointer("pointerdown", 1, 40); pointer("pointermove", 1, 80);
    pointer("lostpointercapture", 1, 80); pointer("pointerup", 1, 80);
    expect(callbacks.onCancel).toHaveBeenCalled();
    expect(callbacks.onEnd).not.toHaveBeenCalled();
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });
});
