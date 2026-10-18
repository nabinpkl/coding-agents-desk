import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopViewerSettings } from "@/features/desktop-viewer/DesktopViewerSettings";
import { MAC_SWIPE_DIRECTION_KEY, useMacSwipeDirection } from "@/features/desktop-viewer/navigation/macSwipeDirection";
import { setOverviewLayer } from "@/features/desktop-viewer/zoom/overviewLayer";
import { setZoomMode } from "@/features/desktop-viewer/zoom/zoomMode";

function renderSettings(overrides: Partial<Parameters<typeof DesktopViewerSettings>[0]> = {}) {
  const props = {
    status: "1920×1080 · webrtc/h265",
    attention: null,
    sourceWidth: 1920,
    sourceHeight: 1080,
    autoKeyboard: true,
    onAutoKeyboardChange: vi.fn(),
    navigation: true,
    hidden: false,
    ...overrides,
  };
  const view = render(<DesktopViewerSettings {...props} />);
  return { ...view, props };
}

afterEach(() => {
  setZoomMode("css");
  setOverviewLayer(false);
  useMacSwipeDirection.getState().setMacDirection(false);
  localStorage.clear();
});

describe("the viewer's settings popover", () => {
  it("holds what the bar used to: status, resolution, zoom model, Auto keyboard and the desktops row's direction", () => {
    const { props } = renderSettings();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Viewer settings" }));
    expect(screen.getByRole("dialog", { name: "Viewer settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("Desktop stream status")).toHaveTextContent("1920×1080 · webrtc/h265");
    expect(screen.getByLabelText("Capture resolution")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    expect(screen.getByRole("button", { name: "Crop" })).toHaveAttribute("aria-pressed", "true");
    const overview = screen.getByLabelText("Overview layer");
    const before = (overview as HTMLInputElement).checked;
    fireEvent.click(overview);
    expect(screen.getByLabelText<HTMLInputElement>("Overview layer").checked).toBe(!before);

    fireEvent.click(screen.getByLabelText("Auto keyboard"));
    expect(props.onAutoKeyboardChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByLabelText("Mac swipe direction"));
    expect(useMacSwipeDirection.getState().macDirection).toBe(true);
    expect(localStorage.getItem(MAC_SWIPE_DIRECTION_KEY)).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers the swipe direction only where there is a desktops row", () => {
    renderSettings({ navigation: false });
    fireEvent.click(screen.getByRole("button", { name: "Viewer settings" }));
    expect(screen.queryByLabelText("Mac swipe direction")).toBeNull();
  });

  it("closes on a tap outside it and on Escape, but not on a tap inside", () => {
    renderSettings();
    const trigger = screen.getByRole("button", { name: "Viewer settings" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByLabelText("Desktop stream status"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Outside is a layer of its own, so the tap that closes it reaches nothing under it.
    fireEvent.click(screen.getByTestId("viewer-settings-dismiss"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("viewer-settings-dismiss")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes when the dock hides, so it does not come back open", () => {
    const { rerender, props } = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Viewer settings" }));
    rerender(<DesktopViewerSettings {...props} hidden />);
    rerender(<DesktopViewerSettings {...props} hidden={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks the button and says why when something needs the reader", () => {
    renderSettings({ attention: "Control v1 unsupported" });
    const trigger = screen.getByRole("button", { name: "Viewer settings" });
    expect(trigger).toHaveAttribute("title", "Control v1 unsupported");
    fireEvent.click(trigger);
    expect(screen.getByRole("status")).toHaveTextContent("Control v1 unsupported");
  });
});
