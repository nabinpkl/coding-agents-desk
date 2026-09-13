import { describe, expect, test } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ActivityEvent, SubagentTranscriptMessage } from "@agentdesk/agent-feed-wire";
import type {
  AgentDataSource,
  SessionReference,
} from "@/features/activity-feed/data-source/AgentDataSource";
import { SubagentTranscript } from "@/features/background-tasks/SubagentTranscript";

const session: SessionReference = { source: "claude", sessionId: "s1", mode: "nice" };

function event(index: number, text: string, type = "assistant"): ActivityEvent {
  return {
    id: `e${index}`,
    index,
    revision: 0,
    phase: "complete",
    type,
    ts: 0,
    blocks: [{ kind: "text", text }],
  } as ActivityEvent;
}

/** A source that hands the component one scripted stream and records the unsubscribe. */
function sourceOf(messages: SubagentTranscriptMessage[], onClose?: () => void): {
  source: AgentDataSource;
  push: (message: SubagentTranscriptMessage) => void;
} {
  let deliver: ((message: SubagentTranscriptMessage) => void) | null = null;
  const source = {
    subscribeSubagentTranscript: (
      _session: SessionReference,
      _agentId: string,
      handlers: { onMessage: (message: SubagentTranscriptMessage) => void },
    ) => {
      deliver = handlers.onMessage;
      for (const message of messages) handlers.onMessage(message);
      return () => onClose?.();
    },
  } as unknown as AgentDataSource;
  return { source, push: (message) => deliver?.(message) };
}

describe("SubagentTranscript", () => {
  test("shows the run once its snapshot lands", async () => {
    const { source } = sourceOf([
      { kind: "snapshot", agentId: "a1", events: [event(0, "reading the transcript")], total: 1 },
    ]);
    render(<SubagentTranscript source={source} session={session} agentId="a1" />);
    expect(await screen.findByText("reading the transcript")).toBeTruthy();
  });

  test("names how much context a fork inherited, which no other run has", async () => {
    const { source } = sourceOf([{
      kind: "snapshot",
      agentId: "a1",
      events: [event(0, "hello")],
      total: 1,
      forkOrigin: { parentSessionId: "s1", parentMessageUuid: "u1", contextLength: 543 },
    }]);
    render(<SubagentTranscript source={source} session={session} agentId="a1" />);
    expect(await screen.findByText(/Forked with 543 messages of context/)).toBeTruthy();
  });

  test("appends rather than replacing, so a growing run keeps what it already showed", async () => {
    const { source, push } = sourceOf([
      { kind: "snapshot", agentId: "a1", events: [event(0, "first")], total: 1 },
    ]);
    render(<SubagentTranscript source={source} session={session} agentId="a1" />);
    expect(await screen.findByText("first")).toBeTruthy();
    act(() => push({ kind: "append", event: event(1, "second") }));
    await waitFor(() => expect(screen.getByText("second")).toBeTruthy());
    // The whole point: the first event is still there.
    expect(screen.getByText("first")).toBeTruthy();
  });

  test("a replayed event does not appear twice", async () => {
    const { source, push } = sourceOf([
      { kind: "snapshot", agentId: "a1", events: [event(0, "only once")], total: 1 },
    ]);
    render(<SubagentTranscript source={source} session={session} agentId="a1" />);
    expect(await screen.findByText("only once")).toBeTruthy();
    act(() => push({ kind: "append", event: event(0, "only once") }));
    await waitFor(() => expect(screen.getAllByText("only once")).toHaveLength(1));
  });

  test("a launched run with nothing on disk says so rather than showing an empty box", async () => {
    const { source } = sourceOf([{ kind: "unavailable", reason: "no transcript on disk yet" }]);
    render(<SubagentTranscript source={source} session={session} agentId="a1" />);
    expect(await screen.findByText("no transcript on disk yet")).toBeTruthy();
  });
});
