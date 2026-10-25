import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Markdown } from "@/features/activity-feed/markdown/Markdown";
import {
  filePathTarget,
  FilePathOpenerContext,
  type FilePathTarget,
} from "@/features/activity-feed/markdown/filePathLinks";

const ROOT = "/Users/me/projects/desk";

describe("filePathTarget", () => {
  it.each([
    ["src/app.ts", "code", { path: "src/app.ts", line: null }],
    ["src/app.ts:42", "code", { path: "src/app.ts", line: 42 }],
    ["src/app.ts:42:7", "code", { path: "src/app.ts", line: 42 }],
    ["./tools/check.sh", "code", { path: "tools/check.sh", line: null }],
    [`${ROOT}/docs/plan.md`, "code", { path: "docs/plan.md", line: null }],
    ["docs/plan.md#L12-L20", "link", { path: "docs/plan.md", line: 12 }],
    ["AGENTS.md", "link", { path: "AGENTS.md", line: null }],
    [`file://${ROOT}/a%20b/c.ts`, "link", { path: "a b/c.ts", line: null }],
    ["src/.env", "code", { path: "src/.env", line: null }],
    [`${ROOT}/AGENTS.md`, "tool", { path: "AGENTS.md", line: null }],
    [`${ROOT}/My Notes/100%25 done.md`, "tool", { path: "My Notes/100%25 done.md", line: null }],
    [`${ROOT}/logs/run:12`, "tool", { path: "logs/run:12", line: null }],
  ] as const)("reads %s as %s", (text, form, expected) => {
    expect(filePathTarget(text, ROOT, form)).toEqual(expected);
  });

  it.each([
    ["AGENTS.md", "code"],
    ["origin/main", "code"],
    ["features/bots/", "code"],
    ["../outside/x.ts", "code"],
    ["/etc/hosts.conf", "code"],
    ["@/features/x.ts", "code"],
    ["https://example.com/a.ts", "link"],
    ["#section", "link"],
    ["git add src/a.ts", "code"],
    ["/Users/me/.claude/settings.json", "tool"],
    [`${ROOT}/../other/a.ts`, "tool"],
  ] as const)("refuses %s as %s", (text, form) => {
    expect(filePathTarget(text, ROOT, form)).toBeNull();
  });
});

function renderWith(content: string, open: (target: FilePathTarget) => void) {
  return render(
    <FilePathOpenerContext.Provider value={{ root: ROOT, open }}>
      <Markdown content={content} />
    </FilePathOpenerContext.Provider>,
  );
}

describe("paths in a message", () => {
  it("opens inline code, links and prose paths, each with its line", () => {
    const open = vi.fn();
    renderWith("Changed `src/app.ts:42`, see [the plan](docs/plan.md) and tools/check.sh:3 for more.", open);

    fireEvent.click(screen.getByText("src/app.ts:42"));
    fireEvent.click(screen.getByText("the plan"));
    fireEvent.click(screen.getByText("tools/check.sh:3"));

    expect(open.mock.calls.map(([target]) => target)).toEqual([
      { path: "src/app.ts", line: 42 },
      { path: "docs/plan.md", line: null },
      { path: "tools/check.sh", line: 3 },
    ]);
    // The relative link no longer points the panel's origin at a page that does not exist.
    expect(screen.getByText("the plan")).not.toHaveAttribute("href");
  });

  it("opens from the keyboard", () => {
    const open = vi.fn();
    renderWith("See `src/app.ts`.", open);
    const path = screen.getByRole("link", { name: "src/app.ts" });
    fireEvent.keyDown(path, { key: "Enter" });
    expect(open).toHaveBeenCalledWith({ path: "src/app.ts", line: null });
  });

  it("leaves web links, code fences and non-paths alone", () => {
    const open = vi.fn();
    const { container } = renderWith(
      "Merge `origin/main` per [docs](https://example.com/a.md).\n\n```\nsrc/app.ts\n```",
      open,
    );
    expect(container.querySelectorAll("[data-file-path]")).toHaveLength(0);
    expect(screen.getByText("docs")).toHaveAttribute("href", "https://example.com/a.md");
  });

  it("marks nothing where no opener is provided", () => {
    const { container } = render(<Markdown content="Changed `src/app.ts` and tools/check.sh." />);
    expect(container.querySelectorAll("[data-file-path]")).toHaveLength(0);
  });
});
