/**
 * Handing a session's context since its newest compaction to a session of the other harness.
 *
 * Four seams, and the direction has to survive all four: which destination a row has, whether
 * the menu offers it and what it says, which call the data source makes, and what the command
 * attaches and opens. A direction that is right in three of them and wrong in the fourth is a
 * handover that starts a session on the wrong harness, or attaches the right one under the wrong
 * source and shows an empty card.
 */

import { describe, expect, it } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { SessionRowMenu } from "@/features/bots/menus/SessionRowMenu";
import { handoverDestination, handoverMenuProp } from "@/features/bots/sessionHandover";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import { useBotCommands } from "@/app/shell-state/useBotCommands";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { botFeeds } from "@/features/bots/botMachines";

/** Enough of a session to be handed over. */
const CLAUDE = {
  source: "claude",
  sessionId: "sid-1",
  title: "Handover driver",
  lastEventAt: 0,
} as unknown as SessionSummary;

const OPENCODE = { ...CLAUDE, source: "opencode", sessionId: "oc-1" } as SessionSummary;
const CODEX = { ...CLAUDE, source: "codex", sessionId: "cx-1" } as SessionSummary;

const BOT = {
  botId: "bot-1",
  environment: { path: "/repo" },
} as unknown as BotView;

function commands(feed: SidecarDataSource, openKeys: Set<string> = new Set()) {
  const machine = { label: "this machine", feed };
  return {
    result: renderHook(() => useBotCommands(
      botFeeds(feed, [machine], () => machine, () => machine, () => []),
      {
        putBotOnCanvas: () => {},
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

describe("where a session's context can go", () => {
  it("is the other harness that compacts, and nowhere from Codex", () => {
    expect(handoverDestination(CLAUDE)).toBe("opencode");
    expect(handoverDestination(OPENCODE)).toBe("claude");
    expect(handoverDestination(CODEX)).toBeNull();
  });

  it("carries the destination and the action together, so they cannot disagree", () => {
    const run = () => {};
    expect(handoverMenuProp(OPENCODE, run)).toEqual({ to: "claude", onSelect: run });
    expect(handoverMenuProp(CODEX, run)).toBeUndefined();
  });
});

describe("the item on the session menu", () => {
  it("names the harness the context is going to, not the one it came from", () => {
    const { unmount } = render(
      <SessionRowMenu
        label="Handover driver"
        onFork={() => {}}
        onForkFromLastMessage={() => {}}
        onForkFromLastCompaction={() => {}}
        handover={{ to: "opencode", onSelect: () => {} }}
        onDetach={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    expect(screen.getByRole("menuitem", { name: "Hand over to opencode" })).toBeTruthy();
    unmount();

    render(
      <SessionRowMenu label="oc-1" handover={{ to: "claude", onSelect: () => {} }} onDetach={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    expect(screen.getByRole("menuitem", { name: "Hand over to Claude" })).toBeTruthy();
  });

  it("is absent without its handler, like every other item", () => {
    render(<SessionRowMenu label="sid-gone" onDetach={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    expect(screen.queryByRole("menuitem", { name: /Hand over/ })).toBeNull();
  });
});

describe("what the data source asks for", () => {
  it("posts the session and the reader's message in one call, to the destination's route", async () => {
    const transport = new FakeHttpTransport();
    transport.responses.set("POST /api/agent-sessions/opencode/handover", {
      status: 201,
      body: JSON.stringify({
        session: { sessionId: "op-1", source: "opencode", projectPath: "/repo", title: "op-1", lastEventAt: 0, activity: "ready", capabilities: { modes: ["nice"] } },
        handover: { turnCount: 4, chars: 100, lossy: false },
      }),
    });
    transport.responses.set("POST /api/agent-sessions/claude/handover", {
      status: 201,
      body: JSON.stringify({
        session: { sessionId: "cl-1", title: "op-1 (handover)", projectPath: "/repo", tmuxSession: "agentdesk-cl-1" },
        handover: { turnCount: 4, chars: 100, lossy: false },
      }),
    });
    const feed = new SidecarDataSource(transport);

    expect((await feed.handoverToOpencode("sid-1", "go on")).session.sessionId).toBe("op-1");
    expect((await feed.handoverToClaude("oc-1", "go on")).session.sessionId).toBe("cl-1");
    expect(transport.requests).toEqual([
      {
        method: "POST",
        path: "/api/agent-sessions/opencode/handover",
        body: { requestId: expect.any(String), sessionId: "sid-1", message: "go on" },
      },
      {
        method: "POST",
        path: "/api/agent-sessions/claude/handover",
        body: { requestId: expect.any(String), sessionId: "oc-1", message: "go on" },
      },
    ]);
  });
});

describe("what the command does with it", () => {
  it("opens the dialog for either harness and ignores a Codex one", async () => {
    const { result } = commands(new SidecarDataSource(new FakeHttpTransport()));

    await act(async () => { result.current.handoverSession(BOT, CLAUDE); });
    expect(result.current.handoverRequest).toEqual({ botId: "bot-1", session: CLAUDE, projectPath: "/repo" });

    await act(async () => { result.current.handoverSession(BOT, OPENCODE); });
    expect(result.current.handoverRequest).toEqual({ botId: "bot-1", session: OPENCODE, projectPath: "/repo" });

    await act(async () => { result.current.handoverSession(BOT, CODEX); });
    expect(result.current.handoverRequest).toEqual({ botId: "bot-1", session: OPENCODE, projectPath: "/repo" });
  });

  it("attaches the started session under the harness it actually started on", async () => {
    // The direction has to survive past the call: attaching an opencode id under `claude` (or the
    // other way) leaves a reference the catalog cannot resolve, and the card opens empty.
    for (const [session, path, startedId, destination] of [
      [CLAUDE, "/api/agent-sessions/opencode/handover", "op-1", "opencode"],
      [OPENCODE, "/api/agent-sessions/claude/handover", "cl-1", "claude"],
    ] as const) {
      const transport = new FakeHttpTransport();
      transport.responses.set(`POST ${path}`, {
        status: 201,
        body: JSON.stringify({
          session: { sessionId: startedId, source: destination, projectPath: "/repo", title: startedId, lastEventAt: 0, activity: "ready", capabilities: { modes: ["nice"] }, tmuxSession: `agentdesk-${startedId}` },
          handover: { turnCount: 4, chars: 100, lossy: false },
        }),
      });
      transport.responses.set("POST /api/bots/bot-1/sessions", { status: 200, body: JSON.stringify({ bot: BOT }) });
      const { result, openKeys } = commands(new SidecarDataSource(transport));

      await act(async () => {
        await result.current.startHandover({ botId: "bot-1", session, projectPath: "/repo" }, "go on");
      });

      expect(result.current.handoverRequest).toBeNull();
      expect(transport.requests.map((request) => request.path)).toEqual([path, "/api/bots/bot-1/sessions"]);
      expect(transport.requests[1]!.body).toMatchObject({
        sessionRefs: [{ source: destination, sessionId: startedId }],
      });
      expect(openKeys.has(`${destination}:${startedId}`)).toBe(true);
      expect(result.current.botCommandError).toBeNull();
    }
  });

  it("names the source session when the handover fails", async () => {
    const transport = new FakeHttpTransport();
    transport.defaultResponse = { status: 404, body: JSON.stringify({ error: { code: "no-compaction-point", message: "never compacted" } }) };
    const { result } = commands(new SidecarDataSource(transport));

    await act(async () => {
      await result.current.startHandover({ botId: "bot-1", session: CLAUDE, projectPath: "/repo" }, "");
    });

    expect(result.current.botCommandError?.session).toBe("claude:sid-1");
    expect(result.current.botCommandError?.message).toContain("Could not hand over");
  });
});
