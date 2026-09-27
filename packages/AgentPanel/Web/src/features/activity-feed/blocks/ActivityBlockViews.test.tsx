/**
 * Render tests for tool-call file bodies: diffs, previews, and shell commands.
 *
 * Apart from the row tests on purpose -- `ActivityEventRows.test.tsx` sits at the file cap,
 * and these are about what the call's body draws rather than the row around it. The DiffBlock
 * is mocked for the same reason it is there: it does not run under jsdom, and Markdown stays
 * REAL, because whether a write preview renders its markup is the whole point.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { stubDataSource } from "@/features/activity-feed/data-source/stubDataSource";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import type { AgentDataSource } from "@/features/activity-feed/data-source/AgentDataSource";
import {
  pairSameEventToolResults,
  withoutPairedToolResults,
} from "@/features/activity-feed/rows/activityFeedLayout";
import {
  SegmentEventRow,
  type EventRowContext,
} from "@/features/activity-feed/blocks/ActivityEventRows";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

vi.mock("@/features/activity-feed/blocks/DiffBlock", () => ({ DiffBlock: () => <div data-testid="diff-block" /> }));

const DATA_SOURCE: AgentDataSource = stubDataSource({
  fetchEventsPage: async () => ({ events: [], total: 0, usage: null }),
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

function fileRow(tool: string, input: Record<string, unknown>) {
  return render(
    <DataSourceProvider source={DATA_SOURCE}>
      <SegmentEventRow
        ev={event([{ kind: "tool_use", tool, input, summary: `${tool} a.ts`, callId: "c1" }])}
        ctx={CTX}
        isFirst
        isLast
        isCollapsed={false}
        onToggle={() => {}}
        isHighlighted={false}
      />
    </DataSourceProvider>,
  );
}

describe("opencode file shapes", () => {
  // Opencode's tools speak camelCase under lowercase names (`edit` with `path`/`oldString`/
  // `newString`); the row draws them through the same diff, preview and shell bodies as
  // Claude's snake_case calls rather than as generic tool cards.
  it("draws an opencode edit through the diff body with the basename header", () => {
    const { container, unmount } = fileRow(
      "edit",
      { path: "/repo/src/a.ts", oldString: "const x = 1;", newString: "const x = 2;" },
    );
    expect(container.querySelector('[data-testid="diff-block"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: /a\.ts/ })).toBeInTheDocument();
    unmount();
  });

  it("renders an opencode markdown write as prose rather than source", () => {
    const { unmount } = fileRow("write", { path: "/repo/NOTES.md", content: "# Notes\n\nHello" });
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
    unmount();
  });

  it("keeps drawing Claude's snake_case edit beside it", () => {
    const { container, unmount } = fileRow(
      "Edit",
      { file_path: "/repo/src/a.ts", old_string: "a", new_string: "b" },
    );
    expect(container.querySelector('[data-testid="diff-block"]')).not.toBeNull();
    unmount();
  });

  it("draws an opencode shell call as a highlighted command", () => {
    const { unmount } = fileRow("shell", { command: "bun test", workdir: "/repo" });
    // The command is the row's body, not just its header: expanding shows it as source.
    expect(screen.getByText("bun test")).toBeInTheDocument();
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
      "Grep pattern \"manifest\"",
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
});
