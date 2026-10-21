import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentReply } from "@/features/activity-feed/markdown/AgentReply";
import { splitReply } from "@/features/activity-feed/markdown/replyReports";

const REPLY = [
  "<task-state>",
  "task: render the reply blocks",
  "- parse in the panel",
  "</task-state>",
  "",
  "It works now.",
  "",
  "<spoken-status>",
  "waiting: say go to commit",
  "done: the blocks render",
  "something with no kind",
  "</spoken-status>",
  "",
  "<next-suggestions-for-user>",
  "",
  "1. Commit it.",
  "",
  "2. Make each step clickable,",
  "   so it lands in the composer.",
  "",
  "</next-suggestions-for-user>",
].join("\n");

describe("splitting a reply", () => {
  it("cuts prose and each block apart, in the order written", () => {
    expect(splitReply(REPLY)).toEqual([
      { kind: "task", task: "render the reply blocks", decisions: ["parse in the panel"] },
      { kind: "prose", text: "\nIt works now.\n" },
      {
        kind: "status",
        lines: [
          { kind: "waiting", text: "say go to commit" },
          { kind: "done", text: "the blocks render" },
          { kind: "note", text: "something with no kind" },
        ],
      },
      { kind: "suggestions", items: ["Commit it.", "Make each step clickable, so it lands in the composer."] },
    ]);
  });

  it("leaves a reply with no blocks as one run of prose", () => {
    expect(splitReply("Just text.\n\nMore.")).toEqual([{ kind: "prose", text: "Just text.\n\nMore." }]);
  });

  it("keeps a block shown inside a code fence as code", () => {
    const shown = ["Write it like this:", "```", "<spoken-status>", "done: x", "</spoken-status>", "```"].join("\n");
    expect(splitReply(shown)).toEqual([{ kind: "prose", text: shown }]);
  });

  it("draws a block still being written with what has arrived", () => {
    expect(splitReply("Done.\n\n<spoken-status>\ndone: the first line")).toEqual([
      { kind: "prose", text: "Done.\n" },
      { kind: "status", lines: [{ kind: "done", text: "the first line" }] },
    ]);
  });

  it("reads a block closed on its own line, and the prose after it", () => {
    expect(splitReply("<spoken-status>note: short</spoken-status> trailing")).toEqual([
      { kind: "status", lines: [{ kind: "note", text: "short" }] },
      { kind: "prose", text: " trailing" },
    ]);
  });

  it("leaves a tag mentioned mid-sentence as prose", () => {
    const mention = "The posture ends with a <spoken-status> block.";
    expect(splitReply(mention)).toEqual([{ kind: "prose", text: mention }]);
  });
});

describe("an agent's reply", () => {
  it("draws each block under its heading, and the prose as Markdown", () => {
    render(<AgentReply content={REPLY} />);
    const task = screen.getByRole("heading", { name: "Task" }).closest("section");
    expect(task).toHaveTextContent("render the reply blocks");
    const status = screen.getByRole("heading", { name: "Status" }).closest("section");
    expect(within(status as HTMLElement).getByText("Needs you:")).toHaveClass("text-attention");
    const next = screen.getByRole("heading", { name: "Next steps" }).closest("section");
    expect(within(next as HTMLElement).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("It works now.")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("<spoken-status>");
  });
});
