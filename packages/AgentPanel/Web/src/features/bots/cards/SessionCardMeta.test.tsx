// The line under a canvas session's title: its task first, the provider as a letter, time last.

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SessionCardMeta } from "@/features/bots/cards/SessionCardMeta";

const AT = new Date(2026, 9, 17, 9, 5).getTime();

describe("SessionCardMeta", () => {
  it("shows what the session set out to do, and opens its decisions on a tap", () => {
    render(
      <SessionCardMeta
        source="claude"
        lastEventAt={AT}
        activity="ready"
        taskState={{ task: "close idle opencode panes", lines: ["dry run first"], at: AT }}
      />,
    );
    const task = screen.getByRole("button", { name: "close idle opencode panes" });
    expect(task).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("dry run first")).toBeNull();
    fireEvent.click(task);
    expect(task).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("dry run first")).toBeInTheDocument();
    fireEvent.click(task);
    expect(screen.queryByText("dry run first")).toBeNull();
  });

  it("opens on a mouse resting on the task and closes when it leaves, unless a click pinned it", () => {
    vi.useFakeTimers();
    try {
      render(
        <SessionCardMeta
          source="claude"
          lastEventAt={AT}
          activity="ready"
          taskState={{ task: "close idle opencode panes", lines: ["dry run first"], at: AT }}
        />,
      );
      const task = screen.getByRole("button", { name: "close idle opencode panes" });
      fireEvent.pointerEnter(task, { pointerType: "mouse" });
      expect(screen.getByText("dry run first")).toBeInTheDocument();
      fireEvent.pointerLeave(task, { pointerType: "mouse" });
      act(() => vi.advanceTimersByTime(200));
      expect(screen.queryByText("dry run first")).toBeNull();

      fireEvent.pointerEnter(task, { pointerType: "mouse" });
      fireEvent.click(task);
      fireEvent.pointerLeave(task, { pointerType: "mouse" });
      act(() => vi.advanceTimersByTime(200));
      expect(screen.getByText("dry run first")).toBeInTheDocument();

      // A finger has no hover: touching the task does not open it, a tap does.
      fireEvent.click(task);
      fireEvent.pointerEnter(task, { pointerType: "touch" });
      expect(screen.queryByText("dry run first")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the provider by a letter, still in full to a screen reader", () => {
    render(<SessionCardMeta source="claude" lastEventAt={AT} activity="ready" />);
    expect(screen.getByLabelText("Source: Claude").textContent).toBe("C");
  });

  it("leaves Cold to the face and puts the time last", () => {
    const { container } = render(<SessionCardMeta source="opencode" lastEventAt={AT} activity="cold" />);
    const row = container.firstElementChild!;
    expect(row.lastElementChild?.textContent).toMatch(/09:05|9:05/);
    expect(screen.getByText("Cold").className).toContain("sr-only");
  });
});
