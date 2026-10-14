import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import { ArchivedSessions } from "@/features/sidebar/session-list/ArchivedSessions";

const filed = {
  source: "claude",
  sessionId: "filed",
  title: "Filed away",
  lastEventAt: 1,
  activity: "cold",
  archivedAt: 2,
} as SessionSummary;

describe("a project's archived sessions", () => {
  it("draws nothing when the project has none", () => {
    const { container } = render(<ArchivedSessions archived={[]} setArchived={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("stays folded behind a count until asked, then unarchives the one picked", () => {
    const setArchived = vi.fn(async () => {});
    render(<ArchivedSessions archived={[filed]} setArchived={setArchived} />);

    expect(screen.queryByText("Filed away")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Archived (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Unarchive Filed away" }));

    expect(setArchived).toHaveBeenCalledWith(filed, false);
  });
});
