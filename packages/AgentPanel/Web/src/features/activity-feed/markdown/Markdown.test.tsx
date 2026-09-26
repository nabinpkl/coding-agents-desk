import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/features/activity-feed/markdown/Markdown";

// A fence nested in a list item is not a different kind of fence, and the reader has no way to
// know it was written one indent further in. Marked renders it as a bare `<pre><code>` inside the
// prose HTML, which no React component can be a child of, so the renderer peels it out and mounts
// the ordinary block into the empty slot left behind. These assert the thing that made the
// difference visible: the chrome, and that nothing is drawing the code twice.

const NESTED = [
  "1. **Files:**",
  "",
  "   ```ts",
  "   const x = 1;",
  "   ```",
  "",
  "2. done",
  "",
].join("\n");

describe("Markdown", () => {
  it("gives a fence inside a list item the same block a top-level one gets", () => {
    const { container } = render(<Markdown content={NESTED} />);
    const block = container.querySelector("li .agent-panel-code");
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain("const x = 1;");
    expect(screen.getByText("ts")).toHaveClass("agent-panel-code__lang");
    expect(screen.getByRole("button", { name: "Copy code" })).not.toBeNull();
  });

  it("draws the nested fence once, in place, rather than beside its own leftovers", () => {
    const { container } = render(<Markdown content={NESTED} />);
    expect(container.querySelectorAll(".agent-panel-code")).toHaveLength(1);
    // Every `pre` the renderer draws belongs to a code block; a bare one would be the peeled
    // fence still rendered by marked, which is what pushed the column wide.
    for (const pre of container.querySelectorAll("pre")) {
      expect(pre.closest(".agent-panel-code")).not.toBeNull();
    }
    // The list survived the peel: the fence did not split it into two.
    expect(container.querySelectorAll("ol")).toHaveLength(1);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
  });

  it("still peels a top-level fence into the same block", () => {
    const { container } = render(<Markdown content={"intro\n\n```ts\nconst y = 2;\n```\n"} />);
    const block = container.querySelector(".agent-panel-code");
    expect(block).not.toBeNull();
    expect(block?.closest("li")).toBeNull();
    expect(block?.textContent).toContain("const y = 2;");
  });

  it("opens feed links in a new tab instead of replacing the panel", () => {
    const { container } = render(
      <Markdown content={'[docs](https://example.com/a)\n\n<a href="https://example.com/b">b</a>\n'} />,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
  });
});
