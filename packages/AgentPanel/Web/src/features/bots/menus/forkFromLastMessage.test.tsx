/**
 * Forking from the last thing a person said, asked for from the session rather than from a row.
 *
 * The row menu on a message can only be reached by scrolling to that message, and one turn of tool
 * calls is enough to put the last one off the screen -- so the affordance was furthest away exactly
 * when the transcript was longest. This is the same fork with the message looked up instead of
 * pointed at, which makes the lookup the part that can be silently wrong: an anchor the rewind
 * picker does not have reads as a fork that worked and did not.
 *
 * Three seams, because they fail differently. The menu decides whether to offer it, the data source
 * decides what it asks, and the command decides what the dialog is opened with -- or, when there is
 * nothing to fork from, what the reader is told instead of a dialog.
 */

import { describe, expect, it } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { SessionRowMenu } from "@/features/bots/menus/SessionRowMenu";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import { useBotCommands } from "@/app/shell-state/useBotCommands";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";

/** Enough of a session to be forked and named. */
const SOURCE = {
  source: "claude",
  sessionId: "sid-1",
  title: "Picker driver",
  lastEventAt: 0,
} as unknown as SessionSummary;

function commands(feed: SidecarDataSource) {
  return renderHook(() => useBotCommands(
    feed,
    {
      setDetachedBotIds: () => {},
      setDetachedSessionKeys: () => {},
      setCanvasOpenKeys: () => {},
    },
    () => {},
  )).result;
}

describe("the item on the session menu", () => {
  it("is offered beside the whole-session fork, not instead of it", () => {
    render(
      <SessionRowMenu
        label="Picker driver"
        onFork={() => {}}
        onForkFromLastMessage={() => {}}
        onDetach={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    // Two forks that answer different questions: all of it, or up to the last thing you said.
    expect(screen.getByRole("menuitem", { name: "Fork session" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Fork from last message" })).toBeTruthy();
  });

  it("is absent on a row that cannot be forked from, rather than inert", () => {
    // A missing reference: the catalog has forgotten the transcript, so there is no last message
    // to find and nothing for the picker to land on.
    render(<SessionRowMenu label="sid-gone" onDetach={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    expect(screen.queryByRole("menuitem", { name: "Fork from last message" })).toBeNull();
  });
});

describe("finding the message", () => {
  it("asks the session's own endpoint rather than paging the transcript", async () => {
    const transport = new FakeHttpTransport();
    transport.defaultResponse = {
      status: 200,
      body: JSON.stringify({ eventId: "claude:sid-1:line:12", text: "Rewrite the picker driver" }),
    };

    const message = await new SidecarDataSource(transport).lastMessage("sid-1");

    expect(transport.requests.at(-1)).toEqual({
      method: "GET",
      path: "/api/sessions/claude/sid-1/last-message",
      body: undefined,
    });
    // Answered in the units the fork takes, so it goes straight back as `from`.
    expect(message).toEqual({ eventId: "claude:sid-1:line:12", text: "Rewrite the picker driver" });
  });
});

describe("what the command does with it", () => {
  it("opens the same dialog the message row does, seeded with what it found", async () => {
    const transport = new FakeHttpTransport();
    transport.defaultResponse = {
      status: 200,
      body: JSON.stringify({ eventId: "claude:sid-1:line:12", text: "Rewrite the picker driver" }),
    };
    const result = commands(new SidecarDataSource(transport));

    await act(async () => {
      await result.current.forkFromLastMessage(SOURCE, "/repo");
    });

    // No Bot, exactly like a fork from a message: this goes to the session endpoint and lands in
    // the catalog on its own rather than on whichever Bot the row was read from.
    expect(result.current.forkRequest).toEqual({
      session: SOURCE,
      projectPath: "/repo",
      from: { eventId: "claude:sid-1:line:12", text: "Rewrite the picker driver" },
    });
  });

  it("says why on the session's own card when there is no message yet", async () => {
    // A session whose first turn has not landed has nothing to fork from. Opening the dialog on an
    // empty anchor would start a fork of the whole conversation wearing a message's label.
    const transport = new FakeHttpTransport();
    transport.defaultResponse = {
      status: 404,
      body: JSON.stringify({
        error: { code: "no-message", message: "nobody has written a message in this session yet" },
      }),
    };
    const result = commands(new SidecarDataSource(transport));

    await act(async () => {
      await result.current.forkFromLastMessage(SOURCE, "/repo");
    });

    expect(result.current.forkRequest).toBeNull();
    // Named against the session, because nothing was started and the card it was asked from is
    // still on the canvas to say so on.
    expect(result.current.botCommandError).toEqual({
      session: "claude:sid-1",
      message: expect.stringContaining("nobody has written a message"),
    });
  });

  it("leaves a Codex session alone, which has no fork to ask for", async () => {
    const transport = new FakeHttpTransport();
    const result = commands(new SidecarDataSource(transport));

    await act(async () => {
      await result.current.forkFromLastMessage(
        { ...SOURCE, source: "codex" } as SessionSummary,
        "/repo",
      );
    });

    expect(result.current.forkRequest).toBeNull();
    expect(transport.requests).toEqual([]);
  });
});
