import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DirectoryEntry, Message } from "@agentdesk/agent-feed-wire";
import { MessagesPanel } from "@/features/messages/MessagesPanel";
import { useMessages } from "@/features/messages/useMessages";
import type { HubHandle } from "@/features/activity-feed/data-source/layers/SidecarHub";

afterEach(() => {
  vi.restoreAllMocks();
});

function message(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    threadId: "m1",
    inReplyTo: null,
    from: "human",
    fromKind: "human",
    to: "opencode:ses_1",
    kind: "request",
    body: "fix the header",
    refs: [],
    hops: 0,
    state: "delivered",
    deliveredTo: "opencode:ses_1",
    deliveredAt: "2026-09-25T09:00:00.000Z",
    answeredBy: null,
    createdAt: "2026-09-25T09:00:00.000Z",
    expiresAt: "2026-10-02T09:00:00.000Z",
    ...over,
  };
}

const directory: DirectoryEntry[] = [
  { address: "human", name: "owner", machine: null, reachability: "reachable", lastSeenAt: null, related: [], cwd: null },
  { address: "bot:fixer", name: "Site fixer", machine: "mac", reachability: "reachable", lastSeenAt: null, related: ["opencode:ses_1"], cwd: "/work/site" },
  { address: "bot:sleeping", name: "Sleeping bot", machine: "mac", reachability: "offline", lastSeenAt: null, related: [], cwd: "/work/site" },
  { address: "opencode:ses_1", name: "OpenCode session", machine: "mac", reachability: "reachable", lastSeenAt: null, related: ["bot:fixer"], cwd: "/work/site" },
];

function feed(over: Record<string, unknown> = {}): HubHandle {
  return {
    threads: vi.fn(async () => []),
    directory: vi.fn(async () => directory),
    send: vi.fn(async () => message()),
    reply: vi.fn(async () => message({ id: "m2", kind: "reply", from: "human", to: "human", state: "delivered" })),
    cancel: vi.fn(async () => message({ state: "cancelled" })),
    ...over,
  } as unknown as HubHandle;
}

function Harness({ data }: { data: HubHandle }) {
  return <MessagesPanel messages={useMessages(data)} />;
}

describe("MessagesPanel", () => {
  test("says so when there is nothing to read", async () => {
    render(<Harness data={feed()} />);
    expect(await screen.findByText("No messages yet")).toBeTruthy();
  });

  test("lists threads with the other side's name and the delivery state in the owner's words", async () => {
    const data = feed({ threads: vi.fn(async () => [[message({ state: "queued", deliveredTo: null })]]) });
    render(<Harness data={data} />);
    expect(await screen.findByText("Site fixer")).toBeTruthy();
    expect(screen.getByText("fix the header")).toBeTruthy();
    expect(screen.getByText("waiting for a live session")).toBeTruthy();
  });

  test("a Bot with no live session is named as such, and the message waits rather than failing", async () => {
    const data = feed();
    render(<Harness data={data} />);
    await screen.findByText("No messages yet");
    fireEvent.change(screen.getByLabelText("Send to"), { target: { value: "bot:sleeping" } });
    expect(screen.getByRole("option", { name: "Sleeping bot (no live session)" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "when you are up" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => {
      expect(data.send).toHaveBeenCalledWith({ to: "bot:sleeping", body: "when you are up" });
    });
  });

  test("an agent's question carries a reply field that answers in its thread", async () => {
    const data = feed({
      threads: vi.fn(async () => [
        [message({ id: "q1", from: "opencode:ses_1", fromKind: "agent", kind: "request", to: "human", state: "delivered" })],
      ]),
    });
    render(<Harness data={data} />);
    await screen.findByText("fix the header");
    fireEvent.change(screen.getByLabelText("Reply to OpenCode session"), { target: { value: "blue" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply to OpenCode session" }));
    await waitFor(() => {
      expect(data.reply).toHaveBeenCalledWith("q1", "blue");
    });
  });

  test("a queued message can be cancelled, because the reader is the one who gave up on it", async () => {
    const data = feed({ threads: vi.fn(async () => [[message({ state: "queued", deliveredTo: null })]]) });
    render(<Harness data={data} />);
    await screen.findByText("waiting for a live session");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(data.cancel).toHaveBeenCalledWith("m1");
    });
  });

  test("the hub being unreachable says why, rather than showing an empty inbox", async () => {
    const data = feed({
      threads: vi.fn(async () => {
        throw new Error('{"error":{"message":"hub not configured"}}');
      }),
    });
    render(<Harness data={data} />);
    expect(await screen.findByText(/hub not configured/)).toBeTruthy();
  });
});
