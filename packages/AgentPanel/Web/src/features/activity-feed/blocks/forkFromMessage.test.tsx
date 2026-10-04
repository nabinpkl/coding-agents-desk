/**
 * The fork affordance on a message row.
 *
 * Its own file rather than more cases in `ActivityEventRows.test.tsx`, because what is pinned here
 * is not how a row renders: it is WHICH rows offer to be forked from, and what the menu reports
 * when one is. Both are answers this panel cannot re-derive -- `displayRole` calls a tool result, a
 * slash command's echo and a `<system-reminder>` "user" as well, so the flag from the sidecar is
 * the only thing separating them -- and getting either wrong is silent: an affordance that never
 * appears, or one that offers a point the rewind picker does not have.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { stubDataSource } from "@/features/activity-feed/data-source/stubDataSource";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import type { AgentDataSource } from "@/features/activity-feed/data-source/AgentDataSource";
import { UserRow, type EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import { ForkSessionDialog } from "@/features/bots/dialogs/ForkSessionDialog";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";

vi.mock("@/features/activity-feed/blocks/diff/DiffBlock", () => ({ DiffBlock: () => <div /> }));

const DATA_SOURCE: AgentDataSource = stubDataSource({
  fetchEventsPage: async () => ({ events: [], windowStart: 0, usage: null }),
  subscribeSessionEvents: () => () => {},
  fetchRawEvent: async () => "",
});

function context(overrides: Partial<EventRowContext> = {}): EventRowContext {
  return {
    session: { source: "claude", sessionId: "session-1", mode: "raw" },
    rawSource: "addressable",
    expandedTools: new Set(),
    onToggleTool: () => {},
    pairedToolResults: new Map(),
    showCacheHits: false,
    ...overrides,
  };
}

function said(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "claude:session-1:line:12",
    index: 3,
    ts: Date.UTC(2026, 8, 9, 12, 0, 0),
    type: "user",
    humanTurn: true,
    blocks: [{ kind: "text", text: "Rewrite the picker driver" }],
    ...overrides,
  };
}

function renderRow(ev: ActivityEvent, ctx: EventRowContext) {
  return render(
    <DataSourceProvider source={DATA_SOURCE}>
      <UserRow ev={ev} ctx={ctx} isCollapsed={false} onToggle={() => {}} isHighlighted={false} />
    </DataSourceProvider>,
  );
}

describe("fork from a message", () => {
  it("reports the row's own event id and the whole message it holds", () => {
    const forked = vi.fn();
    renderRow(said(), context({ onForkFromMessage: forked }));

    fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork from here" }));

    // The id, not the index: in nice mode `index` is the nice one, and the sidecar counts lines.
    expect(forked).toHaveBeenCalledWith({
      eventId: "claude:session-1:line:12",
      text: "Rewrite the picker driver",
    });
  });

  it("is absent on a user-typed row the harness actually wrote", () => {
    // A `<system-reminder>` arrives as `type: "user"` and renders in this same row. The sidecar
    // withholds the flag; without that test this row would offer a fork the picker cannot make.
    renderRow(
      said({ humanTurn: undefined, blocks: [{ kind: "text", text: "<system-reminder>hi</system-reminder>" }] }),
      context({ onForkFromMessage: () => {} }),
    );
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });

  it("is absent on a surface that cannot fork, so nothing offers what it cannot do", () => {
    renderRow(said(), context());
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });

  it("is absent on a row with no event id to anchor to", () => {
    // The live tail has none until the durable transcript catches up, and a fork anchored to
    // nothing would be a fork of the whole conversation wearing a message's label.
    renderRow(said({ id: undefined }), context({ onForkFromMessage: () => {} }));
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });
});

/** Enough of a session for the dialog to name it and number its fork. */
const SOURCE = {
  source: "claude",
  sessionId: "sid-1",
  title: "Picker driver",
  lastEventAt: 0,
} as unknown as SessionSummary;

describe("naming a fork of a message", () => {
  it("offers the message back to be edited, which is what rewind itself does", () => {
    render(
      <ForkSessionDialog
        request={{
          session: SOURCE,
          projectPath: "/repo",
          from: { eventId: "claude:sid-1:line:12", text: "Rewrite the picker driver" },
        }}
        takenTitles={[]}
        onClose={() => {}}
        onFork={() => {}}
      />,
    );

    // Claude's own rewind puts the rewound-to message back in the composer to be edited. Seeding
    // the first turn with it moves that editing to before the fork exists rather than after.
    expect(screen.getByRole("textbox", { name: "" })).toHaveValue("Rewrite the picker driver");
    // And the message is quoted, because "two messages back" is not something a reader can check.
    expect(screen.getByText(/It starts just before this message/).textContent)
      .toContain("Rewrite the picker driver");
  });

  it("says nothing about a message when the whole session is being forked", () => {
    render(
      <ForkSessionDialog
        request={{ session: SOURCE, projectPath: "/repo", botId: "bot-1" }}
        takenTitles={[]}
        onClose={() => {}}
        onFork={() => {}}
      />,
    );
    expect(screen.queryByText(/It starts just before this message/)).toBeNull();
  });
});

describe("the request that reaches the sidecar", () => {
  it("addresses the session, not a Bot, and names the message to start before", async () => {
    const transport = new FakeHttpTransport();
    transport.defaultResponse = {
      status: 201,
      body: JSON.stringify({
        sessionId: "fork-1",
        title: "Picker driver (fork 1)",
        projectPath: "/repo",
        tmuxSession: "agentdesk-fork-fork-1",
      }),
    };
    const feed = new SidecarDataSource(transport);

    const started = await feed.forkSession("sid-1", {
      title: "Picker driver (fork 1)",
      prompt: "Rewrite the picker driver, but settle on a changed screen",
      from: { eventId: "claude:sid-1:line:12" },
    });

    expect(transport.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/sessions/claude/sid-1/fork",
      body: {
        title: "Picker driver (fork 1)",
        prompt: "Rewrite the picker driver, but settle on a changed screen",
        from: { eventId: "claude:sid-1:line:12" },
      },
    });
    expect(started.tmuxSession).toBe("agentdesk-fork-fork-1");
  });
});
