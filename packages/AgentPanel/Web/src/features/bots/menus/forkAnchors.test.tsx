/**
 * The two forks that look their own anchor up rather than being pointed at one: from the last
 * thing a person said, and from the last compaction.
 *
 * The row menu on a message can only be reached by scrolling to that message, and one turn of tool
 * calls is enough to put the last one off the screen -- so the affordance was furthest away exactly
 * when the transcript was longest. A compaction is worse than that and worse in kind: it is not a
 * row the rewind picker offers at all, so the reader cannot point at it even after scrolling to
 * it, and the message under the banner is what a fork can actually be moved to.
 *
 * Looking the anchor up is what makes both of them silently wrong-able: an anchor the picker does
 * not have reads as a fork that worked and did not.
 *
 * Three seams, because they fail differently. The menu decides whether to offer them, the data
 * source decides what it asks for, and the command decides what the dialog is opened with -- or,
 * when there is nothing to fork from, what the reader is told instead of a dialog.
 */

import { describe, expect, it } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { SessionRowMenu } from "@/features/bots/menus/SessionRowMenu";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import { useBotCommands } from "@/app/shell-state/useBotCommands";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { botFeeds } from "@/features/bots/botMachines";

/** Enough of a session to be forked and named. */
const SOURCE = {
  source: "claude",
  sessionId: "sid-1",
  title: "Picker driver",
  lastEventAt: 0,
} as unknown as SessionSummary;

/** The Bot whose card the fork is asked from: what it lands on, and where it is numbered. */
const BOT = { botId: "bot-1", environment: { kind: "directory", path: "/repo" } } as unknown as BotView;

/**
 * One machine, which is what this suite is about: the anchors a fork can start from, not where the
 * session lives. `botMachines.test.ts` covers the routing.
 */
function commands(feed: SidecarDataSource) {
  const machine = { label: "this machine", feed };
  return renderHook(() => useBotCommands(
    botFeeds(feed, [machine], () => machine, () => machine, () => []),
    {
      putBotOnCanvas: () => {},
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
        onForkFromLastCompaction={() => {}}
        onDetach={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    // Three forks that answer different questions, widening from all of it, to the last thing you
    // said, to since the context was summarised.
    expect(screen.getByRole("menuitem", { name: "Fork session" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Fork from last message" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Fork from last compaction" })).toBeTruthy();
  });

  it("is absent on a row that cannot be forked from, rather than inert", () => {
    // A missing reference: the catalog has forgotten the transcript, so there is no last message
    // to find and nothing for the picker to land on.
    render(<SessionRowMenu label="sid-gone" onDetach={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    expect(screen.queryByRole("menuitem", { name: "Fork from last message" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Fork from last compaction" })).toBeNull();
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
      await result.current.forkFromLastMessage(BOT, SOURCE);
    });

    // The card's Bot rides along, so the fork lands on it as a card beside its source.
    expect(result.current.forkRequest).toEqual({
      session: SOURCE,
      projectPath: "/repo",
      botId: "bot-1",
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
      await result.current.forkFromLastMessage(BOT, SOURCE);
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
      await result.current.forkFromLastMessage(BOT, { ...SOURCE, source: "codex" } as SessionSummary);
    });

    expect(result.current.forkRequest).toBeNull();
    expect(transport.requests).toEqual([]);
  });
});

describe("finding the compaction", () => {
  it("asks its own endpoint, because a compaction is not a row anybody can point at", async () => {
    const transport = new FakeHttpTransport();
    transport.defaultResponse = {
      status: 200,
      body: JSON.stringify({ eventId: "claude:sid-1:line:88", text: "Now do the other half" }),
    };

    const message = await new SidecarDataSource(transport).lastCompaction("sid-1");

    expect(transport.requests.at(-1)).toEqual({
      method: "GET",
      path: "/api/sessions/claude/sid-1/last-compaction",
      body: undefined,
    });
    // The message AFTER the compaction, in the units the fork takes: rewinding to it restores the
    // conversation to just before it, which is the summarised context and nothing after.
    expect(message).toEqual({ eventId: "claude:sid-1:line:88", text: "Now do the other half" });
  });

  it("opens the same dialog, seeded with the message under the banner", async () => {
    const transport = new FakeHttpTransport();
    transport.defaultResponse = {
      status: 200,
      body: JSON.stringify({ eventId: "claude:sid-1:line:88", text: "Now do the other half" }),
    };
    const result = commands(new SidecarDataSource(transport));

    await act(async () => {
      await result.current.forkFromLastCompaction(BOT, SOURCE);
    });

    expect(result.current.forkRequest).toEqual({
      session: SOURCE,
      projectPath: "/repo",
      botId: "bot-1",
      from: { eventId: "claude:sid-1:line:88", text: "Now do the other half" },
    });
  });

  it("says why when the session has no compaction to start from", async () => {
    // Two states wear this 404: never compacted, and compacted with nothing said since. Neither is
    // an error to swallow, and the second one has an answer the reader can act on -- the ordinary
    // fork above it in the menu already starts there.
    const transport = new FakeHttpTransport();
    transport.defaultResponse = {
      status: 404,
      body: JSON.stringify({
        error: {
          code: "no-compaction-point",
          message: "this session has nothing said after a compaction to start from",
        },
      }),
    };
    const result = commands(new SidecarDataSource(transport));

    await act(async () => {
      await result.current.forkFromLastCompaction(BOT, SOURCE);
    });

    expect(result.current.forkRequest).toBeNull();
    expect(result.current.botCommandError).toEqual({
      session: "claude:sid-1",
      message: expect.stringContaining("nothing said after a compaction"),
    });
  });
});
