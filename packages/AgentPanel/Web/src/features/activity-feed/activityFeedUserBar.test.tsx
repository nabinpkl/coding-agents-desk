// The user bar for a message the feed does not hold, and the jump that lands on it (ADR-0125).

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import { ActivityFeed } from "@/features/activity-feed/ActivityFeed";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

vi.mock("@/features/activity-feed/markdown/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div data-testid="markdown-view">{content}</div>,
}));
vi.mock("@/features/activity-feed/blocks/diff/DiffBlock", () => ({
  DiffBlock: () => <div data-testid="diff-block" />,
}));

const SESSION = "sid-bar";
/** Rows are 1000 bytes apart, as transcript lines are named by where they start. */
const at = (n: number) => n * 1000;

beforeEach(() => {
  for (const [name, value] of [
    ["offsetWidth", 900],
    ["clientHeight", 800],
    ["scrollHeight", 10000],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
  }
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-index") ? 88 : 800;
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ["offsetWidth", "offsetHeight", "clientHeight", "scrollHeight"]) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
});

function answer(n: number): ActivityEvent {
  return {
    id: `claude:${SESSION}:at:${at(n)}`,
    index: at(n),
    previous: at(n - 1),
    ts: n,
    type: "assistant",
    blocks: [{ kind: "text", text: `answer ${n}` }],
  };
}

function asked(n: number): ActivityEvent {
  return { ...answer(n), type: "user", humanTurn: true, blocks: [{ kind: "text", text: `question ${n}` }] };
}

describe("the user bar for a message the feed does not hold", () => {
  it("asks for the last thing said before the rows it holds, and lands on it in one read", async () => {
    const transport = new FakeHttpTransport();
    // The opening window is a turn with nothing the reader said in it.
    const window = Array.from({ length: 20 }, (_, i) => answer(500 + i));
    transport.responses.set(`GET /api/sessions/claude/${SESSION}/last-message?said=1&before=${at(500)}`, {
      status: 200,
      body: JSON.stringify({ eventId: `claude:${SESSION}:at:${at(100)}`, index: at(100), text: "question 100" }),
    });
    const around = [answer(98), answer(99), asked(100), answer(101), answer(102)];
    around[0] = { ...around[0]!, previous: at(97) };
    transport.responses.set(`GET /api/sessions/claude/${SESSION}/events?around=${at(100)}&limit=100&mode=nice`, {
      status: 200,
      body: JSON.stringify({ events: around, windowStart: at(98), usage: null }),
    });
    // Older paging, should the feed reach for it, finds nothing more.
    transport.defaultResponse = { status: 200, body: JSON.stringify({ events: [], windowStart: 0, usage: null }) };
    const view = render(
      <DataSourceProvider source={new SidecarDataSource(transport)}>
        <ActivityFeed
          source="claude"
          sessionId={SESSION}
          mode="nice"
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
          mode: "nice",
          events: window,
          windowStart: at(500),
          runState: "idle",
          queue: { steer: 0, followUp: 0 },
        },
      });
    });

    const bar = await screen.findByRole("button", { name: /question 100/ });
    fireEvent.click(bar);

    const rows = () => [...view.container.querySelectorAll("[data-index]")].map((row) => row.textContent ?? "");
    await waitFor(() => expect(rows().some((row) => row.includes("question 100"))).toBe(true));
    const reads = transport.requests.filter((request) => request.path.includes("/events?"));
    expect(reads.filter((request) => request.path.includes("around="))).toHaveLength(1);
    // The range opened is a range of its own, and the rows between it and the window are a gap.
    // This fake has nothing to fill it with, so its one page comes back empty and the gap says so
    // rather than asking again.
    await waitFor(() => expect(rows().findIndex((row) => row.includes("did not load"))).toBe(5));
    expect(transport.requests.filter((request) => request.path.includes(`after=${at(102)}`))).toHaveLength(1);
    view.unmount();
  });
});
