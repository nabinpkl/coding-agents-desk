/**
 * Handing a Claude session's context since its newest compaction to a new opencode session.
 *
 * Three seams, mirroring the fork anchors: the menu decides whether to offer it, the data
 * source decides what it asks for, and the command decides what opens and what lands where --
 * the new session attaches to the asking Bot and its card opens on the canvas.
 */

import { describe, expect, it } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { SessionRowMenu } from "@/features/bots/menus/SessionRowMenu";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import { useBotCommands } from "@/app/shell-state/useBotCommands";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { botFeeds } from "@/features/bots/botMachines";

/** Enough of a session to be handed over. */
const SOURCE = {
  source: "claude",
  sessionId: "sid-1",
  title: "Handover driver",
  lastEventAt: 0,
} as unknown as SessionSummary;

const BOT = {
  botId: "bot-1",
  environment: { path: "/repo" },
} as unknown as BotView;

function commands(feed: SidecarDataSource, openKeys: Set<string> = new Set()) {
  const machine = { label: "this machine", feed };
  return {
    result: renderHook(() => useBotCommands(
      botFeeds(feed, [machine], () => machine, () => machine),
      {
        setDetachedBotIds: () => {},
        setDetachedSessionKeys: () => {},
        setCanvasOpenKeys: (update: React.SetStateAction<ReadonlySet<string>>) => {
          const next = typeof update === "function" ? update(openKeys) : update;
          openKeys.clear();
          for (const key of next) openKeys.add(key);
        },
      },
      () => {},
    )).result,
    openKeys,
  };
}

describe("the item on the session menu", () => {
  it("is offered below the forks, which stay inside Claude", () => {
    render(
      <SessionRowMenu
        label="Handover driver"
        onFork={() => {}}
        onForkFromLastMessage={() => {}}
        onForkFromLastCompaction={() => {}}
        onHandoverToOpencode={() => {}}
        onDetach={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    expect(screen.getByRole("menuitem", { name: "Hand over to opencode" })).toBeTruthy();
  });

  it("is absent without its handler, like every other item", () => {
    render(<SessionRowMenu label="sid-gone" onDetach={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    expect(screen.queryByRole("menuitem", { name: "Hand over to opencode" })).toBeNull();
  });
});

describe("what the data source asks for", () => {
  it("posts the session and the reader's message in one call", async () => {
    const transport = new FakeHttpTransport();
    transport.responses.set("POST /api/agent-sessions/opencode/handover", {
      status: 201,
      body: JSON.stringify({
        session: { sessionId: "op-1", source: "opencode", projectPath: "/repo", title: "op-1", lastEventAt: 0, activity: "ready", capabilities: { modes: ["nice"] } },
        handover: { turnCount: 4, chars: 100, lossy: false },
      }),
    });

    const answered = await new SidecarDataSource(transport).handoverToOpencode("sid-1", "go on");

    expect(transport.requests).toEqual([{
      method: "POST",
      path: "/api/agent-sessions/opencode/handover",
      body: { requestId: expect.any(String), sessionId: "sid-1", message: "go on" },
    }]);
    expect(answered.session.sessionId).toBe("op-1");
  });
});

describe("what the command does with it", () => {
  it("opens the dialog for a Claude session and ignores a Codex one", async () => {
    const { result } = commands(new SidecarDataSource(new FakeHttpTransport()));

    await act(async () => {
      result.current.handoverToOpencode(BOT, SOURCE);
    });
    expect(result.current.handoverRequest).toEqual({ botId: "bot-1", session: SOURCE, projectPath: "/repo" });

    await act(async () => {
      result.current.handoverToOpencode(BOT, { ...SOURCE, source: "codex" } as SessionSummary);
    });
    expect(result.current.handoverRequest).toEqual({ botId: "bot-1", session: SOURCE, projectPath: "/repo" });
  });

  it("attaches the started session to the asking Bot and opens its card", async () => {
    const transport = new FakeHttpTransport();
    transport.responses.set("POST /api/agent-sessions/opencode/handover", {
      status: 201,
      body: JSON.stringify({
        session: { sessionId: "op-1", source: "opencode", projectPath: "/repo", title: "op-1", lastEventAt: 0, activity: "ready", capabilities: { modes: ["nice"] } },
        handover: { turnCount: 4, chars: 100, lossy: false },
      }),
    });
    transport.responses.set("POST /api/bots/bot-1/sessions", {
      status: 200,
      body: JSON.stringify({ bot: BOT }),
    });
    const { result, openKeys } = commands(new SidecarDataSource(transport));

    await act(async () => {
      await result.current.startHandover({ botId: "bot-1", session: SOURCE, projectPath: "/repo" }, "go on");
    });

    expect(result.current.handoverRequest).toBeNull();
    expect(transport.requests.map((request) => request.path)).toEqual([
      "/api/agent-sessions/opencode/handover",
      "/api/bots/bot-1/sessions",
    ]);
    expect(transport.requests[1]!.body).toMatchObject({
      sessionRefs: [{ source: "opencode", sessionId: "op-1" }],
    });
    expect(openKeys.has("opencode:op-1")).toBe(true);
    expect(result.current.botCommandError).toBeNull();
  });

  it("names the source session when the handover fails", async () => {
    const transport = new FakeHttpTransport();
    transport.defaultResponse = { status: 404, body: JSON.stringify({ error: { code: "no-compaction-point", message: "never compacted" } }) };
    const { result } = commands(new SidecarDataSource(transport));

    await act(async () => {
      await result.current.startHandover({ botId: "bot-1", session: SOURCE, projectPath: "/repo" }, "");
    });

    expect(result.current.botCommandError?.session).toBe("claude:sid-1");
    expect(result.current.botCommandError?.message).toContain("Could not hand over");
  });
});
