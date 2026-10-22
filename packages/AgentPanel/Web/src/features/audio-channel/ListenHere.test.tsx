import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListenState } from "@/features/audio-channel/radioListener";

const radio = vi.hoisted(() => ({
  state: { phase: "off", detail: null, updatesWaiting: false } as ListenState,
  start: vi.fn(),
  stop: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("@/features/audio-channel/radioListener", () => ({
  startListening: radio.start,
  stopListening: radio.stop,
  reloadForUpdates: radio.reload,
  useListenState: () => radio.state,
}));

const { ListenHereMenuItem, ListenNotice } = await import("@/features/audio-channel/ListenHere");

afterEach(() => {
  radio.start.mockReset();
  radio.stop.mockReset();
  radio.state = { phase: "off", detail: null, updatesWaiting: false };
});

describe("listening to Agent Radio here", () => {
  it("starts from the menu, and stops from it while listening", () => {
    const { rerender } = render(<ListenHereMenuItem />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Listen to Agent Radio here" }));
    expect(radio.start).toHaveBeenCalledTimes(1);
    radio.state = { phase: "listening", detail: null, updatesWaiting: false };
    rerender(<ListenHereMenuItem />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop listening here" }));
    expect(radio.stop).toHaveBeenCalledTimes(1);
  });

  it("asks for the tap after a reload, and only then", () => {
    const { rerender } = render(<ListenNotice />);
    expect(screen.queryByRole("button", { name: "Keep listening to Agent Radio" })).toBeNull();
    radio.state = { phase: "resume", detail: null, updatesWaiting: false };
    rerender(<ListenNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Keep listening to Agent Radio" }));
    expect(radio.start).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
    expect(radio.stop).toHaveBeenCalledTimes(1);
  });

  it("offers the waiting updates while listening, which a reload takes", () => {
    radio.state = { phase: "listening", detail: null, updatesWaiting: true };
    render(<ListenNotice />);
    expect(screen.getByText("Panel updates waiting")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(radio.reload).toHaveBeenCalledTimes(1);
  });
});
