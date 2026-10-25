/**
 * Render tests for tool-call file bodies: diffs, previews, and shell commands.
 *
 * Apart from the row tests on purpose -- `ActivityEventRows.test.tsx` sits at the file cap,
 * and these are about what the call's body draws rather than the row around it. The DiffBlock
 * is mocked for the same reason it is there: it does not run under jsdom, and Markdown stays
 * REAL, because whether a write preview renders its markup is the whole point.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { stubDataSource } from "@/features/activity-feed/data-source/stubDataSource";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import type { AgentDataSource } from "@/features/activity-feed/data-source/AgentDataSource";
import { pairSameEventToolResults, withoutPairedToolResults } from "@/features/activity-feed/rows/activityFeedLayout";
import { SegmentEventRow, type EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import { FilePathOpenerContext, type FilePathOpener } from "@/features/activity-feed/markdown/filePathLinks";

vi.mock("@/features/activity-feed/blocks/diff/DiffBlock", () => ({
  DiffBlock: () => <div data-testid="diff-block" />,
}));

const DATA_SOURCE: AgentDataSource = stubDataSource({
  fetchEventsPage: async () => ({ events: [], windowStart: 0, usage: null }),
  subscribeSessionEvents: () => () => {},
  fetchRawEvent: async () => "",
});

const CTX: EventRowContext = {
  session: { source: "opencode", sessionId: "session-1", mode: "nice" },
  rawSource: "addressable",
  expandedTools: new Set(["c1"]),
  onToggleTool: () => {},
  pairedToolResults: new Map(),
  showCacheHits: true,
};

function event(blocks: ActivityEvent["blocks"]): ActivityEvent {
  return { index: 7, ts: Date.UTC(2026, 0, 1, 12, 0, 0), type: "assistant", blocks };
}

function fileRow(
  tool: string,
  input: Record<string, unknown>,
  result?: string,
  opts?: { omitSummary?: boolean; opener?: FilePathOpener },
) {
  const blocks: ActivityEvent["blocks"] = [
    // An input-less call carries no summary, the way the mapper leaves it.
    ...(opts?.omitSummary
      ? [{ kind: "tool_use", tool, input, callId: "c1" } as const]
      : [{ kind: "tool_use", tool, input, summary: `${tool} a.ts`, callId: "c1" } as const]),
  ];
  if (result !== undefined) blocks.push({ kind: "tool_result", callId: "c1", preview: result });
  const full = event(blocks);
  const paired = pairSameEventToolResults(full);
  return render(
    <DataSourceProvider source={DATA_SOURCE}>
      <FilePathOpenerContext.Provider value={opts?.opener ?? null}>
        <SegmentEventRow
          ev={withoutPairedToolResults(full, paired)}
          ctx={{ ...CTX, pairedToolResults: paired }}
          isFirst
          isLast
          isCollapsed={false}
          onToggle={() => {}}
          isHighlighted={false}
        />
      </FilePathOpenerContext.Provider>
    </DataSourceProvider>,
  );
}

describe("opencode file shapes", () => {
  // Opencode's tools speak camelCase under lowercase names (`edit` with `path`/`oldString`/
  // `newString`); the row draws them through the same diff, preview and shell bodies as
  // Claude's snake_case calls rather than as generic tool cards.
  it("draws an opencode edit through the diff body with the basename header", async () => {
    const { unmount } = fileRow("edit", {
      path: "/repo/src/a.ts",
      oldString: "const x = 1;",
      newString: "const x = 2;",
    });
    // Awaited: the diff's code is loaded when a row first shows one (`DiffBlockOnDemand`).
    expect(await screen.findByTestId("diff-block")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /a\.ts/ })).toBeInTheDocument();
    unmount();
  });

  it("renders an opencode markdown write as prose rather than source", () => {
    const { unmount } = fileRow("write", { path: "/repo/NOTES.md", content: "# Notes\n\nHello" });
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
    unmount();
  });

  it("draws a source write beside its success result", () => {
    const { container, unmount } = fileRow(
      "write",
      { path: "/repo/messages.sweep.mjs", content: "export const sweep = () => [];\n" },
      "Wrote file successfully: /repo/messages.sweep.mjs",
    );
    expect(screen.getByRole("button", { name: /messages\.sweep\.mjs/ })).toBeInTheDocument();
    expect(screen.getByText("export const sweep = () => [];")).toBeInTheDocument();
    expect(screen.getByText("Wrote file successfully: /repo/messages.sweep.mjs")).toBeInTheDocument();
    expect(container.querySelector(".agent-panel-code")).not.toBeNull();
    unmount();
  });

  it("keeps drawing Claude's snake_case edit beside it", () => {
    const { container, unmount } = fileRow("Edit", { file_path: "/repo/src/a.ts", old_string: "a", new_string: "b" });
    expect(container.querySelector('[data-testid="diff-block"]')).not.toBeNull();
    unmount();
  });

  it("names an edit's change on its own row under the filename header", () => {
    const { unmount } = fileRow("edit", {
      path: "/repo/src/a.ts",
      oldString: "export function old() {\n  return 1;\n}",
      newString: "export function old() {\n  return 1;\n}\nexport function next() {\n  return 2;\n}",
    });
    // Header keeps the file; the detail line names the change, not inline.
    expect(screen.getByRole("button", { name: /a\.ts/ })).toBeInTheDocument();
    expect(screen.getByText("adds next(), +3/-0")).toBeInTheDocument();
    unmount();
  });

  it("chips an input-less edit as Edit with no doubled label", () => {
    const { unmount } = fileRow("edit", {}, undefined, { omitSummary: true });
    // Chip alone holds the row until input streams in: never `edit edit`.
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    unmount();
  });

  it("draws an opencode shell call as a highlighted command", () => {
    const { unmount } = fileRow("shell", { command: "bun test", workdir: "/repo" });
    // The command is the row's body, not just its header: expanding shows it as source.
    expect(screen.getByText("bun test")).toBeInTheDocument();
    unmount();
  });

  it("opens straight onto the command, with the summary once in the header", () => {
    const label = "Test describeEditChange.test.ts, filter for FAIL";
    const blocks: ActivityEvent["blocks"] = [
      { kind: "tool_use", tool: "shell", input: { command: "npx vitest" }, summary: label, callId: "c1" },
    ];
    const full = event(blocks);
    const paired = pairSameEventToolResults(full);
    const { unmount } = render(
      <DataSourceProvider source={DATA_SOURCE}>
        <SegmentEventRow
          ev={withoutPairedToolResults(full, paired)}
          ctx={{ ...CTX, pairedToolResults: paired }}
          isFirst
          isLast
          isCollapsed={false}
          onToggle={() => {}}
          isHighlighted={false}
        />
      </DataSourceProvider>,
    );
    // Said once, in the header, with the whole line on hover; the body is the command.
    expect(screen.getAllByText(label)).toHaveLength(1);
    expect(screen.getByText(label)).toHaveAttribute("title", label);
    expect(screen.getByText("npx vitest")).toBeInTheDocument();
    unmount();
  });
});

describe("read bodies", () => {
  // A read's result is the file's content, so expanding draws it as source under the call's own
  // grammar rather than as a plain pre. The result's own text is suppressed there, the way a
  // skill's echo is: the code view IS the result, and drawing it twice is the row repeating
  // itself. Paired through the same helper the feed uses, so the test pairs what it renders.
  function readRow(tool: string, input: Record<string, unknown>, preview: string) {
    const full = event([
      { kind: "tool_use", tool, input, summary: `${tool} a.ts`, callId: "c1" },
      { kind: "tool_result", preview, callId: "c1" },
    ]);
    const paired = pairSameEventToolResults(full);
    return render(
      <DataSourceProvider source={DATA_SOURCE}>
        <SegmentEventRow
          ev={withoutPairedToolResults(full, paired)}
          ctx={{ ...CTX, pairedToolResults: paired }}
          isFirst
          isLast
          isCollapsed={false}
          onToggle={() => {}}
          isHighlighted={false}
        />
      </DataSourceProvider>,
    );
  }

  it("draws an opencode source read as code, stripped of cat -n line numbers", () => {
    const { container, unmount } = readRow("read", { path: "/repo/src/a.ts" }, "     1\tconst x = 1;");
    expect(screen.getByText("const x = 1;")).toBeInTheDocument();
    expect(container.textContent).not.toContain("1\tconst");
    unmount();
  });

  it("renders a markdown read as prose rather than source", () => {
    const { unmount } = readRow("read", { path: "/repo/NOTES.md" }, "# Notes\n\nHello");
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
    unmount();
  });

  it("keeps drawing Claude's snake_case Read beside it", () => {
    const { unmount } = readRow("Read", { file_path: "/repo/src/a.ts" }, "let y = 2;");
    expect(screen.getByText("let y = 2;")).toBeInTheDocument();
    unmount();
  });
});

describe("search bodies", () => {
  // A search result is a list, so expanding draws it structured -- content matches grouped by
  // file, file answers as rows -- instead of one wrapping `pre`. Same pairing boilerplate.
  function searchRow(tool: string, input: Record<string, unknown>, summary: string, preview: string) {
    const full = event([
      { kind: "tool_use", tool, input, summary, callId: "c1" },
      { kind: "tool_result", preview, callId: "c1" },
    ]);
    const paired = pairSameEventToolResults(full);
    return render(
      <DataSourceProvider source={DATA_SOURCE}>
        <SegmentEventRow
          ev={withoutPairedToolResults(full, paired)}
          ctx={{ ...CTX, pairedToolResults: paired }}
          isFirst
          isLast
          isCollapsed={false}
          onToggle={() => {}}
          isHighlighted={false}
        />
      </DataSourceProvider>,
    );
  }

  it("draws a glob answer as rows with no wrapping pre left behind", () => {
    const { container, unmount } = searchRow(
      "glob",
      { pattern: "src/**/*.ts" },
      "glob src/**/*.ts",
      "Found 2 files\nsrc/a.ts\nsrc/b.ts",
    );
    expect(screen.getByText("Found 2 files")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    // The file rows are divs, not a pre: a pre here would be the generic result behind them.
    expect(container.querySelector("pre")).toBeNull();
    unmount();
  });

  it("groups grep content matches under the file with no generic result behind them", () => {
    const { container, unmount } = searchRow(
      "Grep",
      { pattern: "manifest", output_mode: "content" },
      'Grep pattern "manifest"',
      "host/Provider.swift:38:    func manifest() {",
    );
    expect(screen.getByText("Provider.swift")).toBeInTheDocument();
    // textContent rather than getByText: the highlighter tokenizes the match across spans. The
    // full `path:line:` prefix appears nowhere: the code block carries `38:` without the path,
    // so a generic `pre` behind it would be the only source of the unstripped line.
    expect(container.textContent).toContain("func manifest()");
    expect(container.textContent).not.toContain("host/Provider.swift:38");
    unmount();
  });

  it("renders a web fetch as prose with no generic result behind it", () => {
    const { container, unmount } = searchRow(
      "WebFetch",
      { url: "https://example.com/a", prompt: "Summarize" },
      "WebFetch https://example.com/a",
      "# Cost Analysis\n\n**Author:** Someone",
    );
    expect(screen.getByRole("heading", { name: "Cost Analysis" })).toBeInTheDocument();
    expect(container.textContent).not.toContain("**Author:**");
    expect(container.querySelector("pre")).toBeNull();
    unmount();
  });

  it("draws a web search as links and prose, without its frame", () => {
    const { container, unmount } = searchRow(
      "WebSearch",
      { query: "bun watch" },
      "WebSearch bun watch",
      'Web search results for query: "bun watch"\n\n' +
        'Links: [{"title":"Watch mode","url":"https://bun.sh/docs/watch"}]\n\n' +
        "Bun reloads on **content** changes.\n\n\n" +
        "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.",
    );
    expect(screen.getByRole("link", { name: "Watch mode" })).toHaveAttribute("href", "https://bun.sh/docs/watch");
    expect(screen.getByText("content").tagName).toBe("STRONG");
    expect(container.textContent).not.toContain("Links: [");
    expect(container.textContent).not.toContain("REMINDER");
    expect(container.querySelector("pre")).toBeNull();
    unmount();
  });
});

describe("opening the file a call worked on", () => {
  // The viewer reads one directory (the Bot's, or the session's worktree), and only a file inside
  // it can be opened there.
  it.each([
    ["Edit", { file_path: "/repo/src/a.ts", old_string: "a", new_string: "b" }],
    ["write", { path: "/repo/src/a.ts", content: "export {};\n" }],
    ["Read", { file_path: "/repo/src/a.ts" }],
  ] as const)("opens a %s call's file in the code viewer", async (tool, input) => {
    const open = vi.fn();
    const { unmount } = fileRow(tool, input, undefined, { opener: { root: "/repo", open } });
    fireEvent.click(await screen.findByRole("button", { name: "Open src/a.ts in the code viewer" }));
    expect(open).toHaveBeenCalledWith({ path: "src/a.ts", line: null });
    unmount();
  });

  it("offers none for a file outside that directory, a row with no viewer, or another tool", () => {
    const opener = { root: "/repo", open: vi.fn() };
    for (const row of [
      () => fileRow("Read", { file_path: "/elsewhere/a.ts" }, undefined, { opener }),
      () => fileRow("Read", { file_path: "/repo/src/a.ts" }),
      () => fileRow("Grep", { pattern: "x", path: "/repo/src/a.ts" }, undefined, { opener }),
    ]) {
      const { unmount } = row();
      expect(screen.queryByRole("button", { name: /in the code viewer/ })).toBeNull();
      unmount();
    }
  });
});
