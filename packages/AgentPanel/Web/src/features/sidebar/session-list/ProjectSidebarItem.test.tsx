import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import { ProjectSessionPreview } from "@/features/sidebar/session-list/ProjectSidebarItem";

const loose = { source: "claude", sessionId: "loose", title: "Loose", lastEventAt: 1, activity: "ready" } as SessionSummary;
const held = { ...loose, sessionId: "held", title: "Held" } as SessionSummary;

describe("a session row's Move to canvas", () => {
  it("is offered on a session no Bot holds, and moves that session", () => {
    const onMove = vi.fn();
    render(
      <ProjectSessionPreview
        sessions={[loose, held]}
        selectedSessionKey={null}
        onSelect={() => {}}
        canvasMove={{ held: new Set(["claude:held"]), onMove }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Actions for Held" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Loose" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to canvas" }));

    expect(onMove).toHaveBeenCalledWith(loose);
  });

  it("has no menu where the list offers no move", () => {
    render(<ProjectSessionPreview sessions={[loose]} selectedSessionKey={null} onSelect={() => {}} />);
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
  });
});

describe("archiving from the project list", () => {
  it("offers Archive on every row and names the reason a refusal gave", async () => {
    const setArchived = vi.fn(async () => {
      throw new Error("this session is still running; stop it before archiving it");
    });
    render(
      <ProjectSessionPreview
        sessions={[loose]}
        selectedSessionKey={null}
        onSelect={() => {}}
        archiving={{ archivedByProject: new Map(), setArchived }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Actions for Loose" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive session" }));

    expect(setArchived).toHaveBeenCalledWith(loose, true);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not archive Loose: this session is still running; stop it before archiving it",
    );
  });
});

describe("a project's security reviews", () => {
  const review = (sessionId: string, activity: SessionSummary["activity"] = "ready") => ({
    ...loose,
    sessionId,
    title: `Review ${sessionId}`,
    activity,
    automation: "security-review",
  }) as SessionSummary;

  it("sit folded in one row below the person's sessions, however recent they are", () => {
    // Newest first, as the stream sends them: the reviews lead, and still land under the fold.
    render(
      <ProjectSessionPreview
        sessions={[review("one", "live"), review("two"), loose]}
        selectedSessionKey={null}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByRole("list", { name: "Sessions" })).toHaveTextContent("Loose");
    const fold = screen.getByRole("button", { name: /Security reviews \(2\)/ });
    expect(fold).toHaveTextContent("1 running");
    expect(screen.queryByRole("button", { name: /^Review one/ })).toBeNull();

    fireEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("list", { name: "Security reviews" })).toHaveTextContent("Review one");
  });

  it("are the whole list when a project has nothing else, rather than no sessions", () => {
    render(<ProjectSessionPreview sessions={[review("one")]} selectedSessionKey={null} onSelect={() => {}} />);
    expect(screen.queryByRole("list", { name: "Sessions" })).toBeNull();
    expect(screen.getByRole("button", { name: /Security reviews \(1\)/ })).toBeInTheDocument();
  });
});
