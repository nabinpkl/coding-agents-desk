// The line under a canvas session's title: its task first, the provider as a letter, time last.

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
