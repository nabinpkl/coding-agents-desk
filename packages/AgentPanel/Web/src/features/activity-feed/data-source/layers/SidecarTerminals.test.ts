/**
 * Everything said to a terminal that is open, and what the data source owes the far end.
 *
 * Split out of `SidecarDataSource.test.ts` when the write-ordering tests took that file past the
 * 500-line cap. It rides with `SidecarTerminals.ts`, which is the class these exercise.
 */

import { describe, expect, it, vi } from "vitest";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";

describe("SidecarTerminals", () => {
  it("owns terminal creation, streaming, input, and resize over the Agent Feed routes", async () => {
    const transport = new FakeHttpTransport();
    const descriptor = {
      terminalId: "terminal-1",
      ptySessionName: "agent-resume-codex-session-1",
      pid: 42,
      columns: 80,
      rows: 24,
    };
    transport.responses.set("POST /api/terminals", {
      status: 201,
      body: JSON.stringify(descriptor),
    });
    transport.responses.set("POST /api/terminals/terminal-1/input", { status: 204, body: "" });
    transport.responses.set("POST /api/terminals/terminal-1/viewport", { status: 204, body: "" });
    const source = new SidecarDataSource(transport);
    const messages: unknown[] = [];

    expect(
      await source.openTerminal(
        {
          kind: "agent-session",
          projectPath: "/projects/agent-desk",
          source: "codex",
          sessionId: "session-1",
        },
        80,
        24,
      ),
    ).toEqual(descriptor);
    source.subscribeTerminal("terminal-1", { onMessage: (message) => messages.push(message) });
    transport.open("/api/terminals/stream");
    await Promise.resolve();
    transport.deliver("/api/terminals/stream", {
      terminalId: "terminal-1",
      message: { type: "output", revision: "2", data: "aGk=" },
    });
    await source.sendTerminalInput("terminal-1", "pwd\r");
    await source.updateTerminalViewport("terminal-1", {
      sequence: "1",
      active: true,
      claim: true,
      columns: 100,
      rows: 30,
    });

    expect(messages).toEqual([{ type: "output", revision: "2", data: "aGk=" }]);
    expect(transport.requests.slice(-4)).toEqual([
      {
        method: "POST",
        path: "/api/terminals",
        body: {
          context: {
            kind: "agent-session",
            projectPath: "/projects/agent-desk",
            source: "codex",
            sessionId: "session-1",
          },
          columns: 80,
          rows: 24,
        },
      },
      // The viewer asks for its own screen replay, because the stream it joined is shared and
      // may have been running for another terminal long before this one existed.
      {
        method: "POST",
        path: "/api/terminals/terminal-1/checkpoint",
        body: undefined,
      },
      {
        method: "POST",
        path: "/api/terminals/terminal-1/input",
        body: { data: "pwd\r", encoding: "utf8" },
      },
      {
        method: "POST",
        path: "/api/terminals/terminal-1/viewport",
        body: {
          sequence: "1",
          active: true,
          claim: true,
          columns: 100,
          rows: 30,
        },
      },
    ]);
  });

  it("writes a terminal one keystroke at a time, in the order they were pressed", async () => {
    // Fired and forgotten, all three left at once and the shell took them in whatever order they
    // landed: measured through the IDE's terminal, `echo ide-terminal-$PWD` reached the prompt as
    // `echo ide-etinrmla-$PWD`.
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const release = transport.hold("POST /api/terminals/terminal-1/input");
    const writes = () =>
      transport.requests
        .filter((request) => request.path === "/api/terminals/terminal-1/input")
        .map((request) => (request.body as { data: string }).data);

    const typed = ["e", "c", "h", "o"].map((key) => source.sendTerminalInput("terminal-1", key));
    await Promise.resolve();
    expect(writes()).toEqual(["e"]);

    release();
    await Promise.all(typed);
    expect(writes()).toEqual(["e", "c", "h", "o"]);
  });

  it("keeps one write per key rather than merging what is waiting into one", async () => {
    // The far end is a TUI, and a burst arriving in one `read` is not the same event as four
    // keystrokes: Claude's composer, readline and zsh's autosuggestions all treat it as a paste.
    // Merging the queue would be faster and would make a person's typing read as a machine's.
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const release = transport.hold("POST /api/terminals/terminal-1/input");

    const typed = ["l", "s", "\r"].map((key) => source.sendTerminalInput("terminal-1", key));
    release();
    await Promise.all(typed);

    expect(transport.requests.filter((request) => request.path.endsWith("/input"))).toHaveLength(3);
  });

  it("takes the next keystroke after one is refused, rather than wedging the terminal shut", async () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    transport.responses.set("POST /api/terminals/terminal-1/input", { status: 500, body: "" });

    await expect(source.sendTerminalInput("terminal-1", "a")).rejects.toThrow();
    transport.responses.set("POST /api/terminals/terminal-1/input", { status: 204, body: "" });
    await source.sendTerminalInput("terminal-1", "b");

    expect(transport.requests.map((request) => (request.body as { data: string }).data)).toEqual(["a", "b"]);
  });

  it("waits for the shared stream to carry before asking for a screen replay", async () => {
    // Nothing replays a message published while no observer was attached, and the stream connects a
    // round trip after it is asked to. Asking first left the terminal blank and silent, because
    // tmux sends nothing to a client that is already attached and unchanged.
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);

    source.subscribeTerminal("terminal-1", { onMessage: () => {} });
    await Promise.resolve();
    expect(transport.requests).toEqual([]);

    transport.open("/api/terminals/stream");
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.requests).toEqual([
      { method: "POST", path: "/api/terminals/terminal-1/checkpoint", body: undefined },
    ]);
  });

  it("serves every terminal from one connection, and holds none when all have closed", () => {
    // HTTP/1.1 gives a browser about six connections per origin and an EventSource holds one for
    // life, so a stream each would strand the seventh terminal and the panel's own requests too.
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const first: unknown[] = [];
    const second: unknown[] = [];

    const stopFirst = source.subscribeTerminal("terminal-1", { onMessage: (m) => first.push(m) });
    const stopSecond = source.subscribeTerminal("terminal-2", { onMessage: (m) => second.push(m) });
    expect(transport.subscriptions.map((subscription) => subscription.path)).toEqual(["/api/terminals/stream"]);

    transport.deliver("/api/terminals/stream", {
      terminalId: "terminal-2",
      message: { type: "output", revision: "7", data: "Zm9v" },
    });
    expect(first).toEqual([]);
    expect(second).toEqual([{ type: "output", revision: "7", data: "Zm9v" }]);

    stopFirst();
    expect(transport.subscriptions).toHaveLength(1);
    stopSecond();
    expect(transport.subscriptions).toHaveLength(0);
  });

  it("does not tell a later viewer its stream failed to open when an earlier one gave up waiting", () => {
    // The open timeout belonged to the closure that started it, not to the stream, so closing the
    // stream before it carried left the timer running. A viewer that reopened in time got the
    // abandoned stream's "did not open" error eight seconds later, on a stream that was carrying.
    vi.useFakeTimers();
    try {
      const transport = new FakeHttpTransport();
      const source = new SidecarDataSource(transport);
      const errors: string[] = [];

      const stopFirst = source.subscribeTerminal("terminal-1", { onMessage: () => {} }, { replay: false });
      vi.advanceTimersByTime(4_000);
      stopFirst();
      expect(transport.subscriptions).toHaveLength(0);

      source.subscribeTerminal(
        "terminal-2",
        { onMessage: () => {}, onError: (reason) => errors.push(reason) },
        { replay: false },
      );
      transport.open("/api/terminals/stream");
      vi.advanceTimersByTime(60_000);

      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still tells a viewer when its own stream never opens", () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeHttpTransport();
      const source = new SidecarDataSource(transport);
      const errors: string[] = [];

      source.subscribeTerminal(
        "terminal-1",
        { onMessage: () => {}, onError: (reason) => errors.push(reason) },
        { replay: false },
      );
      vi.advanceTimersByTime(8_000);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Terminal stream did not open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a composer turn as one safe bracketed paste through the owned terminal", async () => {
    const transport = new FakeHttpTransport();
    transport.responses.set("POST /api/terminals/terminal-1/input", { status: 204, body: "" });
    const source = new SidecarDataSource(transport);

    await source.sendTerminalPrompt("terminal-1", "first line\nsecond \u001b[31mline");

    expect(transport.requests).toEqual([
      {
        method: "POST",
        path: "/api/terminals/terminal-1/input",
        body: {
          data: "\u001b[200~first line\nsecond \u241b[31mline\u001b[201~\r",
          encoding: "utf8",
        },
      },
    ]);
  });

  it("refuses an oversized terminal prompt before writing partial input", async () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);

    await expect(source.sendTerminalPrompt("terminal-1", "x".repeat(64 * 1024))).rejects.toThrow("64 KiB");
    expect(transport.requests).toEqual([]);
  });
});
