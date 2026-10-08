import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import { ActivityFeed } from "@/features/activity-feed/ActivityFeed";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

// Same jsdom-unsafe deps the other feed-level tests stub.
vi.mock("@/features/activity-feed/markdown/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => (
    <div data-testid="markdown-view">{content}</div>
  ),
}));
vi.mock("@/features/activity-feed/blocks/diff/DiffBlock", () => ({ DiffBlock: () => <div data-testid="diff-block" /> }));

const VIEWPORT = 800;
/** What an expanded row estimates to, and what every row here stays at: nothing re-measures. */
const ROW = 88;
/** Taller than anything these threads reach, so "at the end" is a place you have to scroll to. */
const CONTENT = 10000;
const STORAGE_KEY = "agent-panel.transcript-scroll.positions";
const SESSION = "sid-scroll";

beforeEach(() => {
  localStorage.clear();
  // jsdom has no layout, so every geometry the feed reads has to be supplied. clientHeight and
  // scrollHeight are what the tail-follower asks how far from the end the reader is, and left at
  // zero it reads every position as the end and re-attaches on the first scroll.
  for (const [name, value] of [
    ["offsetWidth", 900],
    ["clientHeight", VIEWPORT],
    ["scrollHeight", CONTENT],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
  }
  // offsetHeight is BOTH the height the virtualiser measures its scroller with and the height it
  // measures each row with, so one value for every element makes every row as tall as the viewport
  // and puts twelve of them where thirty belong. A row is the one the virtualiser already
  // estimates; only the scroller is the viewport.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-index") ? ROW : VIEWPORT;
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // Reflect rather than `delete`: these are declared readonly on HTMLElement.
  for (const name of ["offsetWidth", "offsetHeight", "clientHeight", "scrollHeight"]) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
});

function durable(index: number): ActivityEvent {
  return {
    id: `claude:line:${index}`,
    index,
    otherModeIndex: index,
    revision: 0,
    phase: "complete",
    ts: 1000 + index,
    type: "assistant",
    messageId: `msg_${index}`,
    blocks: [{ kind: "text", text: `line ${index}` }],
  };
}

function mountFeed(
  events = Array.from({ length: 30 }, (_, index) => durable(index)),
  windowStart = 0,
  mode: "nice" | "raw" = "nice",
  olderWindowStart = windowStart,
) {
  const transport = new FakeHttpTransport();
  // Paging older answers with an empty page. A feed that opens partway through a thread asks for
  // the page before it as soon as it lands near the top, and the fake's own default body has no
  // events field at all.
  transport.defaultResponse = {
    status: 200,
    body: JSON.stringify({ events: [], windowStart: olderWindowStart }),
  };
  const view = render(
    <DataSourceProvider source={new SidecarDataSource(transport)}>
      <ActivityFeed
        source="claude"
        sessionId={SESSION}
        mode={mode}
        onToggleMode={() => {}}
        showCacheHits={false}
        onToggleCacheHits={() => {}}
        controlsHost={null}
      />
    </DataSourceProvider>,
  );
  act(() => {
    transport.deliver(SESSION, {
      type: "timeline",
      envelope: {
        kind: "snapshot",
        sequence: 1,
        mode,
        events,
        windowStart,
        runState: "idle",
        queue: { steer: 0, followUp: 0 },
      },
    });
  });
  const scroller = view.container.querySelector<HTMLDivElement>("div.overflow-y-auto");
  if (!scroller) throw new Error("the feed rendered no scroller");
  return { view, scroller, transport, events };
}

/** Where the virtualiser has placed the row carrying this text. */
function rowTop(text: string): number {
  const row = screen.getByText(text).closest<HTMLElement>("[data-index]");
  if (!row) throw new Error(`no row is rendering ${text}`);
  return Number(/translateY\((-?\d+(?:\.\d+)?)px\)/.exec(row.style.transform)?.[1]);
}

/** What the browser does on its own after a scroll offset is written. */
function scrollTo(scroller: HTMLElement, top: number): void {
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
}

/**
 * What these cannot cover, so nobody reads a green run as more than it is.
 *
 * jsdom measures nothing: a row reports a height only when its element mounts, and the inert
 * ResizeObserver means one already on screen never reports again. So the layout here is settled
 * from the first commit, and the failure that shipped -- a restore landing on estimates and then
 * being left behind as the real heights arrive -- cannot happen in this file. The check for that
 * is `chrome-test/panel-scroll-memory-verify.mjs`, against the running panel.
 */
describe("where a session was left being read", () => {
  it("keeps a row too wide for the column inside its own band", async () => {
    // jsdom measures nothing, so this cannot show a wide row being contained; what it guards is
    // that the band still DECLARES the containment, which is the line a later reader is most
    // likely to delete as decoration. Without it the feed's `overflow-y-auto` computes its other
    // axis to `auto` as well, and one overflowing descendant slides the whole transcript
    // sideways. The behaviour itself was measured in the running panel: the same 2400px child on
    // the same row put 1975px of scroll on the column with this off, and none with it on.
    const { view } = mountFeed();
    const row = (await screen.findByText("line 0")).closest<HTMLElement>("[data-index]");
    expect(row?.style.overflowX).toBe("auto");
    view.unmount();
  });

  it("opens a session at the tail when it has never been read away from it", async () => {
    const { scroller, view } = mountFeed();
    expect(await screen.findByText("line 0")).toBeInTheDocument();
    expect(scroller.scrollTop).toBe(0);
    view.unmount();
  });

  it("puts the reader back on the line they were reading, and does not chase the tail there", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([[`claude:${SESSION}`, 20]]));
    const { scroller, view } = mountFeed();
    // The restore waits for the rows to be measured, which is a commit or two after they arrive.
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
    // jsdom writes a scroll offset without telling anyone, where a browser dispatches the scroll
    // event the assignment causes -- and that event is how the virtualiser learns where it is, so
    // without this the rows around the restored offset are never the ones rendered.
    fireEvent.scroll(scroller);

    // Asserted as a position rather than as a number of pixels, because that is the whole claim:
    // the line that was being read is at the top of the viewport, wherever the rows above it
    // happen to have measured to.
    expect(await screen.findByText("line 20")).toBeInTheDocument();
    expect(scroller.scrollTop).toBe(rowTop("line 20"));
    // Detached, or the first row to be measured would snap the reader straight back to the end.
    expect(screen.getByRole("button", { name: "scroll to bottom" })).toBeInTheDocument();
    view.unmount();
  });

  it("reapplies the saved line when a timeline snapshot replaces the rows", async () => {
    const events = Array.from({ length: 30 }, (_, index) => durable(index));
    const { scroller, view, transport } = mountFeed(events);
    await screen.findByText("line 0");

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([[`claude:${SESSION}`, 100, "claude:line:4"]]),
    );
    fireEvent.wheel(scroller, { deltaY: -240 });
    scrollTo(scroller, rowTop("line 4"));

    // Model the sidecar replacing the projection while the card stays mounted: the browser's
    // scroll offset is gone, but the next snapshot still describes the same event identities.
    act(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      transport.deliver(SESSION, {
        type: "timeline",
        envelope: {
          kind: "snapshot",
          sequence: 2,
          mode: "nice",
          events,
          windowStart: 0,
          stableIndices: true,
          runState: "idle",
          queue: { steer: 0, followUp: 0 },
        },
      });
    });

    await waitFor(() => expect(scroller.scrollTop).toBe(rowTop("line 4")));
    view.unmount();
  });

  it("remembers the line reached by scrolling up, and forgets it on the way back to the end", async () => {
    const { scroller, view } = mountFeed();
    await screen.findByText("line 0");

    // Up, which only an input can say -- the scroll event it produces cannot. From line 8, because
    // jsdom opens the scroller at 0 rather than at the end; a move with no input behind it would be
    // pinned straight back to the tail, so this one comes under the same flick.
    fireEvent.wheel(scroller, { deltaY: -240 });
    scrollTo(scroller, rowTop("line 8"));
    scrollTo(scroller, rowTop("line 4"));

    await waitFor(
      () => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"))
        .toEqual([[`claude:${SESSION}`, 4, "claude:line:4"]]),
      { timeout: 2000 },
    );

    // Back at the end, which is where a session opens anyway, so the entry goes with it.
    scrollTo(scroller, CONTENT - VIEWPORT);
    await waitFor(
      () => expect(localStorage.getItem(STORAGE_KEY)).toBeNull(),
      { timeout: 2000 },
    );
    view.unmount();
  });

  it("keeps every shell call collapsed until opened on click", async () => {
    const shell = (index: number, callId: string, output: string): ActivityEvent => ({
      id: `claude:shell:${index}`,
      index,
      revision: 0,
      phase: "complete",
      ts: 1000 + index,
      type: "assistant",
      blocks: [
        { kind: "tool_use", tool: "shell", callId, input: { command: "git status" }, summary: "git status" },
        { kind: "tool_result", callId, text: output, preview: output },
      ],
    });
    const { view } = mountFeed([
      shell(0, "shell-old", "old output"),
      shell(1, "shell-new", "new output"),
    ]);
    expect(screen.queryByText("new output")).toBeNull();
    expect(screen.queryByText("old output")).toBeNull();
    view.unmount();
  });

  it("does not present the first loaded row while an older anchor is still paging in", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([[`claude:${SESSION}`, 3, "claude:line:3"]]),
    );
    const { view } = mountFeed(
      Array.from({ length: 20 }, (_, index) => durable(index + 40)),
      40,
      "nice",
      40,
    );

    expect(await screen.findByRole("status")).toHaveTextContent("restoring your place");
    view.unmount();
  });

  it("reads once around a line older than the loaded window, and lands on the nearest it has", async () => {
    // A reader who paged far up and reloaded: the feed opens on the newest window, so the line they
    // were on is not loaded yet. It reads one page around that line rather than paging back to it;
    // this fake's page holds nothing, so the window's first row is the nearest place that exists.
    localStorage.setItem(STORAGE_KEY, JSON.stringify([[`claude:${SESSION}`, 3]]));
    const { scroller, view, transport } = mountFeed(
      Array.from({ length: 20 }, (_, index) => durable(index + 40)),
      40,
    );
    await screen.findByText("line 40");
    await waitFor(() => expect(scroller.scrollTop).toBe(rowTop("line 40")));
    const reads = transport.requests.filter((request) => request.path.includes("/events?"));
    expect(reads.filter((request) => request.path.includes("around=3&"))).toHaveLength(1);
    view.unmount();
  });
});
