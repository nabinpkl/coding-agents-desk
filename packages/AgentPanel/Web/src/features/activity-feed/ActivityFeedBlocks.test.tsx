import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataSourceProvider } from "./data-source/AgentDataSourceContext";
import type { AgentDataSource } from "./data-source/AgentDataSource";
import {
  buildFeedLayout,
  eventPreview,
  leadEvent,
  isFlowBlock,
  partitionEventBlocks,
  shellCommand,
  toolIntent,
  stripInlineMarkdown,
} from "./activityDisplayItems";
import {
  LabeledTextBlock,
  RawDetails,
  RawJsonBlock,
  formatRawJson,
  RAW_JSON_FORMAT_MAX_CHARS,
} from "./ActivitySystemBlocks";
import type { ActivityEvent } from "./useSessionEventsStream";
import { stubDataSource } from "./data-source/stubDataSource";

function source(fetchRawEvent: AgentDataSource["fetchRawEvent"]): AgentDataSource {
  return stubDataSource({ fetchRawEvent });
}

describe("complete activity blocks", () => {
  it("renders Plain and metadata text without HTML interpretation", () => {
    const { container, rerender } = render(
      <LabeledTextBlock block={{ kind: "plain", label: "Plain", text: "<img src=x onerror=alert(1)>" }} />,
    );
    expect(screen.getByText("Plain")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();

    rerender(<LabeledTextBlock block={{ kind: "metadata", label: "Token Usage", text: "42" }} />);
    expect(screen.getByText("Token Usage")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("keeps Raw JSON collapsed and fetches the exact line only when opened", async () => {
    const exact = '{"type":"future","html":"<b>literal</b>"}';
    // The fetch is held open and released by hand rather than resolved on a microtask
    // that a `waitFor` poll then chases, so the render step waits on this test's own
    // signal instead of the scheduler's.
    let release: ((text: string) => void) | null = null;
    const fetchRawEvent = vi.fn(
      () => new Promise<string>((resolve) => { release = resolve; }),
    );
    const { container } = render(
      <DataSourceProvider source={source(fetchRawEvent)}>
        <RawJsonBlock
          session={{ source: "claude", sessionId: "session", mode: "raw" }}
          eventIndex={7}
        />
      </DataSourceProvider>,
    );

    const details = container.querySelector("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(fetchRawEvent).not.toHaveBeenCalled();

    // The disclosure is opened and its `toggle` dispatched directly, because jsdom
    // schedules `toggle` after a click as a task: waiting for it took 1027ms of a
    // 1000ms poll under full-suite load. `open` + `toggle` IS the contract this
    // component listens on, so dispatching it exercises the same path with no clock
    // in the loop.
    details.open = true;
    fireEvent(details, new Event("toggle"));

    // The mode travels WITH the index, because the index is counted in it: a fetch
    // that dropped it would read a different line.
    expect(fetchRawEvent).toHaveBeenCalledWith(
      { source: "claude", sessionId: "session", mode: "raw" },
      7,
    );

    await act(async () => { release!(exact); });
    // The drawer pretty-prints the line. The pre may be the plain fallback or
    // the Shiki-highlighted markup depending on whether the singleton loaded
    // during this run, so assert on the element's merged text content rather
    // than text matchers (Testing Library's getNodeText only sees direct text
    // nodes, which the highlighted path has none of).
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain('"type": "future"');
    expect(pre?.textContent).toContain("<b>literal</b>");
    expect(screen.getByLabelText("Copy raw JSON")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
  });

  it("leaves unparseable raw lines exactly as fetched", async () => {
    const notJson = "2026-08-09T00:00:00Z event not json";
    const fetchRawEvent = vi.fn(async () => notJson);
    const { container } = render(
      <DataSourceProvider source={source(fetchRawEvent)}>
        <RawJsonBlock
          session={{ source: "claude", sessionId: "session", mode: "raw" }}
          eventIndex={8}
        />
      </DataSourceProvider>,
    );
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await act(async () => {});
    expect(container.querySelector("pre")?.textContent).toBe(notJson);
  });

  it("skips formatting for raw lines past the format cap", async () => {
    const huge = `{"data":"${"x".repeat(RAW_JSON_FORMAT_MAX_CHARS)}"}`;
    const fetchRawEvent = vi.fn(async () => huge);
    const { container } = render(
      <DataSourceProvider source={source(fetchRawEvent)}>
        <RawJsonBlock
          session={{ source: "claude", sessionId: "session", mode: "raw" }}
          eventIndex={9}
        />
      </DataSourceProvider>,
    );
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await act(async () => {});
    // The exact compact line, unformatted: no pretty-print newlines, still over
    // the cap in length.
    const rendered = container.querySelector("pre")?.textContent;
    expect(rendered).toBe(huge);
  });

  it("formatRawJson pretty-prints valid JSON and passes through everything else", () => {
    expect(formatRawJson('{"a":1,"b":[true,null]}')).toBe(
      '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}',
    );
    expect(formatRawJson("plain text")).toBe("plain text");
    expect(formatRawJson('{"unclosed": ')).toBe('{"unclosed": ');
    // The cap is respected by the pure function as well as the component.
    const atCap = `[${"0,".repeat(RAW_JSON_FORMAT_MAX_CHARS)}0]`;
    expect(formatRawJson(atCap)).toBe(atCap);
  });

});

// The Claude adapter appends a Working Directory block to nearly every line,
// which is what defeated both "is this event only X?" predicates below.
const CWD = { kind: "metadata", label: "Working Directory", text: "/repo" } as const;

describe("feed layout", () => {
  it("pairs a result into its call even when the line carries metadata", () => {
    const events: ActivityEvent[] = [
      {
        index: 10,
        ts: 1,
        type: "assistant",
        blocks: [{ kind: "tool_use", tool: "Read", callId: "call-1" }, CWD, { kind: "raw" }],
      },
      {
        index: 11,
        ts: 2,
        type: "user",
        blocks: [
          { kind: "tool_result", preview: "result", callId: "call-1" },
          CWD,
          { kind: "raw" },
        ],
      },
    ];

    const layout = buildFeedLayout(events);
    expect(layout.items.map((item) => leadEvent(item).index)).toEqual([10]);
    expect(layout.allEventIds).toEqual([10]);

    // The result event surrendered its row, so its metadata and raw line ride
    // into the tool call rather than disappearing.
    const paired = layout.pairedToolResults.get("call-1");
    expect(paired?.eventIndex).toBe(11);
    expect(paired?.includesRawEvent).toBe(true);
    expect(paired?.metadata.map((block) => block.label)).toEqual(["Working Directory"]);
  });

  it("gives only the first result of an event the raw line and metadata", () => {
    const layout = buildFeedLayout([
      {
        index: 20,
        ts: 1,
        type: "assistant",
        blocks: [
          { kind: "tool_use", tool: "Read", callId: "call-1" },
          { kind: "tool_use", tool: "Read", callId: "call-2" },
        ],
      },
      {
        index: 21,
        ts: 2,
        type: "user",
        blocks: [
          { kind: "tool_result", preview: "first", callId: "call-1" },
          { kind: "tool_result", preview: "second", callId: "call-2" },
          CWD,
          { kind: "raw" },
        ],
      },
    ]);

    expect(layout.pairedToolResults.get("call-1")?.includesRawEvent).toBe(true);
    expect(layout.pairedToolResults.get("call-1")?.metadata).toHaveLength(1);
    expect(layout.pairedToolResults.get("call-2")?.includesRawEvent).toBe(false);
    expect(layout.pairedToolResults.get("call-2")?.metadata).toEqual([]);
  });

  it("keeps an event holding more than results as its own row", () => {
    const layout = buildFeedLayout([
      {
        index: 30,
        ts: 1,
        type: "assistant",
        blocks: [{ kind: "tool_use", tool: "Read", callId: "call-1" }],
      },
      {
        index: 31,
        ts: 2,
        type: "user",
        blocks: [
          { kind: "tool_result", preview: "result", callId: "call-1" },
          { kind: "text", text: "and one more thing" },
        ],
      },
    ]);

    expect(layout.items.map((item) => leadEvent(item).index)).toEqual([30, 31]);
    expect(layout.pairedToolResults.size).toBe(0);
  });

  it("keeps a result with no matching call as its own row", () => {
    const layout = buildFeedLayout([
      {
        index: 40,
        ts: 1,
        type: "user",
        blocks: [{ kind: "tool_result", preview: "orphan", callId: "call-missing" }, CWD],
      },
    ]);

    expect(layout.items.map((item) => leadEvent(item).index)).toEqual([40]);
    expect(layout.pairedToolResults.size).toBe(0);
  });

  it("renders a compaction banner even when the line carries metadata", () => {
    const layout = buildFeedLayout([
      {
        index: 50,
        ts: 1,
        type: "system",
        blocks: [{ kind: "compaction" }, CWD, { kind: "raw" }],
      },
    ]);

    expect(layout.items.map((item) => item.kind)).toEqual(["compaction"]);
  });
});

describe("event block partition", () => {
  it("folds metadata and the raw line away from an event that has content", () => {
    const layout = partitionEventBlocks({
      index: 12,
      ts: 1,
      type: "assistant",
      blocks: [
        { kind: "tool_use", tool: "Bash", summary: "ls", callId: "call-1" },
        { kind: "metadata", label: "Token Usage", text: "1,234 tokens" },
        { kind: "metadata", label: "Stop Reason", text: "tool_use" },
        { kind: "metadata", label: "Working Directory", text: "/repo" },
        { kind: "raw" },
      ],
    });

    expect(layout.inline.map(({ block }) => block.kind)).toEqual(["tool_use"]);
    expect(layout.folded.map((block) => block.label)).toEqual([
      "Token Usage",
      "Stop Reason",
      "Working Directory",
    ]);
    expect(layout.hasRawJson).toBe(true);
  });

  it("keeps metadata inline when it is the event's only content", () => {
    const layout = partitionEventBlocks({
      index: 13,
      ts: 1,
      type: "system",
      blocks: [
        { kind: "metadata", label: "Agent Message", text: "finished indexing" },
        { kind: "raw" },
      ],
    });

    expect(layout.inline.map(({ block }) => block.label)).toEqual(["Agent Message"]);
    expect(layout.folded).toEqual([]);
    expect(layout.hasRawJson).toBe(true);
  });

  it("keeps each inline block's original index so tool keys stay stable", () => {
    const layout = partitionEventBlocks({
      index: 14,
      ts: 1,
      type: "assistant",
      blocks: [
        { kind: "text", text: "running it" },
        { kind: "metadata", label: "Working Directory", text: "/repo" },
        { kind: "tool_use", tool: "Bash", summary: "ls" },
        { kind: "raw" },
      ],
    });

    expect(layout.inline.map(({ index }) => index)).toEqual([0, 2]);
  });
});

describe("event preview", () => {
  it("strips the markers a one-line preview cannot render", () => {
    // A reasoning trace opening with a bolded topic put `**` on screen in the
    // collapsed row and the sticky bar -- the same defect as rendering the body
    // as plain text, one layer out.
    expect(
      eventPreview({
        index: 1,
        ts: 1,
        type: "reasoning",
        blocks: [{ kind: "reasoning", text: "**Adjusting skip handling**\n\nmore" }],
      }),
    ).toBe("Adjusting skip handling");
  });

  it("takes the first content block, whatever kind it is", () => {
    expect(
      eventPreview({
        index: 2,
        ts: 1,
        type: "assistant",
        blocks: [{ kind: "tool_use", tool: "Bash", summary: "ls -la" }],
      }),
    ).toBe("ls -la");
  });

  it("names a harness state line by its label, not '(no content)'", () => {
    // A metadata block IS the content of these lines -- the whole event is one
    // labelled dump. Scanning only text, tool and reasoning blocks made every such
    // row in the raw view read as a chip beside "(no content)", which is exactly the
    // rows the raw view exists to show.
    expect(
      eventPreview({
        index: 4,
        ts: 1,
        type: "system",
        blocks: [
          { kind: "metadata", label: "Hook", text: '{"exitCode":0}' },
          { kind: "raw" },
        ],
      }),
    ).toBe('Hook: {"exitCode":0}');

    // Label alone when there is no body, and body alone when there is no label.
    expect(
      eventPreview({
        index: 5,
        ts: 1,
        type: "system",
        blocks: [{ kind: "metadata", label: "Date Change" }],
      }),
    ).toBe("Date Change");
    expect(
      eventPreview({
        index: 6,
        ts: 1,
        type: "system",
        blocks: [{ kind: "plain", text: "unrecognized record" }],
      }),
    ).toBe("unrecognized record");
  });

  it("prefers real content over a metadata block on the same event", () => {
    // The adapters append Working Directory to nearly every Claude line, so a
    // metadata-first scan would label half the thread with a file path.
    expect(
      eventPreview({
        index: 7,
        ts: 1,
        type: "assistant",
        blocks: [
          { kind: "text", text: "Done." },
          { kind: "metadata", label: "Working Directory", text: "/repo" },
        ],
      }),
    ).toBe("Done.");
  });

  it("caps the line so one long paragraph cannot stretch a row", () => {
    const preview = eventPreview({
      index: 3,
      ts: 1,
      type: "assistant",
      blocks: [{ kind: "text", text: "x".repeat(400) }],
    });
    expect(preview).toHaveLength(200);
  });

  it("leaves prose that merely contains asterisks alone", () => {
    expect(stripInlineMarkdown("2 * 3 * 4 equals 24")).toBe("2 * 3 * 4 equals 24");
  });

  it("unwraps headings, bullets, quotes, emphasis and code spans", () => {
    expect(stripInlineMarkdown("## Heading")).toBe("Heading");
    expect(stripInlineMarkdown("- a bullet")).toBe("a bullet");
    expect(stripInlineMarkdown("> quoted")).toBe("quoted");
    expect(stripInlineMarkdown("_underscored_ and *starred*")).toBe("_underscored_ and starred");
    expect(stripInlineMarkdown("call `render()` now")).toBe("call render() now");
  });
});

describe("flow blocks", () => {
  it("names exactly the kinds that may sit beside the floated heading", () => {
    // Anything else is a bordered box, which a float overlaps rather than
    // flows around, so it has to clear.
    expect(isFlowBlock({ kind: "text", text: "x" })).toBe(true);
    expect(isFlowBlock({ kind: "reasoning", text: "x" })).toBe(true);
    expect(isFlowBlock({ kind: "tool_use", tool: "Bash" })).toBe(false);
    expect(isFlowBlock({ kind: "tool_result", preview: "x" })).toBe(false);
    expect(isFlowBlock({ kind: "metadata", label: "m", text: "x" })).toBe(false);
    expect(isFlowBlock({ kind: "plain", label: "p", text: "x" })).toBe(false);
  });
});

describe("shell command extraction", () => {
  it("prefers the raw input the macOS panel receives", () => {
    expect(
      shellCommand({
        kind: "tool_use",
        tool: "Bash",
        summary: "git log --oneline",
        input: { command: "git log --oneline --graph --decorate --all" },
      }),
    ).toBe("git log --oneline --graph --decorate --all");
  });

  it("falls back to the summary when the wire dropped the input", () => {
    expect(shellCommand({ kind: "tool_use", tool: "shell", summary: "ls -la" })).toBe("ls -la");
    // Codex `shell` can carry argv rather than a command string.
    expect(
      shellCommand({
        kind: "tool_use",
        tool: "shell",
        summary: "ls -la",
        input: { command: ["bash", "-lc", "ls -la"] },
      }),
    ).toBe("ls -la");
  });

  it("returns null for tools that do not run a shell command", () => {
    expect(shellCommand({ kind: "tool_use", tool: "Read", summary: "Read App.tsx" })).toBeNull();
    expect(shellCommand({ kind: "text", text: "prose" })).toBeNull();
  });
});

describe("raw drawer", () => {
  it("is absent from Nice even when metadata and raw JSON are available", () => {
    const { container } = render(
      <DataSourceProvider source={source(async () => "")}>
        <RawDetails
          metadata={[{ kind: "metadata", label: "Working Directory", text: "/repo" }]}
          session={{ source: "claude", sessionId: "session", mode: "nice" }}
          eventIndex={12}
          includesRawJson
        />
      </DataSourceProvider>,
    );

    expect(container.querySelector("details")).toBeNull();
    expect(screen.queryByText("Raw")).toBeNull();
  });

  it("holds the metadata and only fetches the raw line from the nested disclosure", async () => {
    const exact = '{"type":"assistant"}';
    let release: ((text: string) => void) | null = null;
    const fetchRawEvent = vi.fn(
      () => new Promise<string>((resolve) => { release = resolve; }),
    );
    const { container } = render(
      <DataSourceProvider source={source(fetchRawEvent)}>
        <RawDetails
          metadata={[
            { kind: "metadata", label: "Token Usage", text: "1,234 tokens" },
            { kind: "metadata", label: "Working Directory", text: "/repo" },
          ]}
          session={{ source: "claude", sessionId: "session", mode: "raw" }}
          eventIndex={12}
          includesRawJson
        />
      </DataSourceProvider>,
    );

    const drawers = container.querySelectorAll("details");
    expect(drawers.length).toBe(2);
    expect(drawers[0]?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Token Usage")).toBeTruthy();
    expect(screen.getByText("Working Directory")).toBeTruthy();

    // Opening the OUTER drawer must not fetch: that is what makes the nested Raw
    // JSON lazy. Dispatched directly for the same reason as above -- waiting on
    // jsdom to schedule `toggle` is a bet on the scheduler, and `open` + `toggle` is
    // the contract these drawers listen on.
    const [outer, inner] = [drawers[0]!, drawers[1]!];
    outer.open = true;
    fireEvent(outer, new Event("toggle"));
    expect(fetchRawEvent).not.toHaveBeenCalled();

    inner.open = true;
    fireEvent(inner, new Event("toggle"));
    expect(fetchRawEvent).toHaveBeenCalledTimes(1);

    await act(async () => { release!(exact); });
    // Shiki splits the rendered line into token spans, so assert on the merged
    // text content: the pretty-printed form with a spaced key. The metadata
    // blocks render their own <pre>s first, so the raw JSON one is the last.
    const pres = container.querySelectorAll("pre");
    const rawPre = pres[pres.length - 1];
    expect(rawPre?.textContent).toContain('"type": "assistant"');
  });

  it("takes a label so a paired call's two source lines stay distinguishable", () => {
    render(
      <DataSourceProvider source={source(async () => "")}>
        <RawDetails
          metadata={[]}
          session={{ source: "claude", sessionId: "session", mode: "raw" }}
          eventIndex={12}
          includesRawJson
          label="Raw result"
        />
      </DataSourceProvider>,
    );

    expect(screen.getByText("Raw result")).toBeTruthy();
    expect(screen.queryByText("Raw")).toBeNull();
  });

  it("renders nothing when the event has no metadata and no raw line", () => {
    const { container } = render(
      <DataSourceProvider source={source(async () => "")}>
        <RawDetails
          metadata={[]}
          session={{ source: "claude", sessionId: "session", mode: "raw" }}
          eventIndex={12}
          includesRawJson={false}
        />
      </DataSourceProvider>,
    );

    expect(container.querySelector("details")).toBeNull();
  });
});

describe("toolIntent", () => {
  const bash = (input: Record<string, unknown>) => ({
    blocks: [{ kind: "tool_use" as const, tool: "Bash", summary: "just check", input }],
  });

  it("reads the agent's description off a tool call", () => {
    // It rides the role heading; the command stays on the tool row, so both are visible at once.
    expect(toolIntent(bash({ command: "just check", description: "Run 2-hour looped logger" })))
      .toBe("Run 2-hour looped logger");
  });

  it("is null when the call carried no description, leaving the heading as it was", () => {
    expect(toolIntent(bash({ command: "just check" }))).toBeNull();
    expect(toolIntent(bash({ command: "just check", description: "   " }))).toBeNull();
  });

  it("ignores blocks that are not tool calls", () => {
    expect(toolIntent({ blocks: [{ kind: "text", text: "describe this" }] })).toBeNull();
  });

  it("takes the first description when an event ran several calls at once", () => {
    // A heading is one line. The rest keep their own rows.
    expect(toolIntent({
      blocks: [
        { kind: "tool_use", tool: "Read", input: { file_path: "/a" } },
        { kind: "tool_use", tool: "Bash", input: { command: "a", description: "first" } },
        { kind: "tool_use", tool: "Bash", input: { command: "b", description: "second" } },
      ],
    })).toBe("first");
  });
});
