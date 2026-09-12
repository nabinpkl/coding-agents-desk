import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataSourceProvider } from "./data-source/AgentDataSourceContext";
import type { AgentDataSource } from "./data-source/AgentDataSource";
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
