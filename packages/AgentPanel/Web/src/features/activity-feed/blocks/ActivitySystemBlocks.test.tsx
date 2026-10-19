import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SCRATCH_BRIEF_LABEL } from "@agentdesk/agent-feed-wire";
import { ScratchBriefDrawer } from "@/features/activity-feed/blocks/ActivitySystemBlocks";

describe("a scratch chat's brief", () => {
  it("is folded under its label and opens to its text", () => {
    render(
      <ScratchBriefDrawer
        blocks={[
          { kind: "metadata", label: SCRATCH_BRIEF_LABEL, text: "You are in a folder made for this chat." },
          { kind: "text", text: "Plan the garden" },
        ]}
      />,
    );
    const summary = screen.getByText(SCRATCH_BRIEF_LABEL);
    expect(summary.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(screen.getByText("You are in a folder made for this chat.")).toBeInTheDocument();
  });

  it("is absent from a message that has none", () => {
    const { container } = render(
      <ScratchBriefDrawer
        blocks={[
          { kind: "metadata", label: "Working Directory", text: "/x" },
          { kind: "text", text: "hi" },
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
