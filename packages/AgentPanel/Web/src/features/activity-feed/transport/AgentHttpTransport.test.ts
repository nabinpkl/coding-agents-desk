/**
 * What the relay transport owns, and only that: correlation, reassembly, and transfer lifetime.
 *
 * The suite this replaces asserted field-by-field that thirteen request types became the matching
 * response types. Those tests passed on both sides of every drift they were supposed to catch,
 * because each side was checked against its own copy of the shape. There is one shape now and it
 * carries no field of anything the sidecar says, so what is left worth asserting is whether the
 * right answer reaches the right caller.
 */

import { describe, expect, it } from "vitest";
import { RelayHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import { FakeHostBridge } from "@/features/activity-feed/data-source/HostBridge";

function lastRequest(bridge: FakeHostBridge) {
  return [...bridge.posted]
    .reverse()
    .find((message) => (message as { t?: string }).t === "agent-http-req") as {
    rid: string;
    method: string;
    path: string;
    body?: string;
    stream: boolean;
  };
}

describe("RelayHttpTransport", () => {
  it("resolves a request from the frames carrying its own rid", async () => {
    const bridge = new FakeHostBridge();
    const transport = new RelayHttpTransport(bridge);

    const pending = transport.request("POST", "/api/agent-sessions", { body: { source: "pi" } });
    const sent = lastRequest(bridge);
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/api/agent-sessions");
    expect(sent.body).toBe(JSON.stringify({ source: "pi" }));
    expect(sent.stream).toBe(false);

    bridge.deliver({ t: "agent-http-head", rid: sent.rid, status: 201 });
    bridge.deliver({ t: "agent-http-chunk", rid: sent.rid, seq: 0, data: '{"ok":1}', complete: true });
    bridge.deliver({ t: "agent-http-end", rid: sent.rid });

    expect(await pending).toEqual({ status: 201, body: '{"ok":1}' });
  });

  it("keeps two in-flight requests apart", async () => {
    const bridge = new FakeHostBridge();
    const transport = new RelayHttpTransport(bridge);

    const first = transport.request("GET", "/api/config");
    const firstRid = lastRequest(bridge).rid;
    const second = transport.request("GET", "/api/sessions");
    const secondRid = lastRequest(bridge).rid;
    expect(secondRid).not.toBe(firstRid);

    // Answered out of order, which is the whole reason the rid exists: the relay interleaves by
    // rid so a large transfer cannot hold a small one behind it.
    bridge.deliver({ t: "agent-http-head", rid: secondRid, status: 200 });
    bridge.deliver({ t: "agent-http-chunk", rid: secondRid, seq: 0, data: "second", complete: true });
    bridge.deliver({ t: "agent-http-end", rid: secondRid });
    bridge.deliver({ t: "agent-http-head", rid: firstRid, status: 200 });
    bridge.deliver({ t: "agent-http-chunk", rid: firstRid, seq: 0, data: "first", complete: true });
    bridge.deliver({ t: "agent-http-end", rid: firstRid });

    expect((await first).body).toBe("first");
    expect((await second).body).toBe("second");
  });

  it("reassembles a body split across chunks", async () => {
    const bridge = new FakeHostBridge();
    const transport = new RelayHttpTransport(bridge);

    const pending = transport.request("GET", "/api/sessions/pi/s1/events/4/raw");
    const { rid } = lastRequest(bridge);
    bridge.deliver({ t: "agent-http-head", rid, status: 200 });
    bridge.deliver({ t: "agent-http-chunk", rid, seq: 0, data: "one ", complete: false });
    bridge.deliver({ t: "agent-http-chunk", rid, seq: 1, data: "two ", complete: false });
    bridge.deliver({ t: "agent-http-chunk", rid, seq: 2, data: "three", complete: true });
    bridge.deliver({ t: "agent-http-end", rid });

    expect((await pending).body).toBe("one two three");
  });

  it("fails a transfer whose chunks arrive with a gap rather than joining them anyway", async () => {
    const bridge = new FakeHostBridge();
    const transport = new RelayHttpTransport(bridge);

    const pending = transport.request("GET", "/api/config");
    const { rid } = lastRequest(bridge);
    bridge.deliver({ t: "agent-http-head", rid, status: 200 });
    bridge.deliver({ t: "agent-http-chunk", rid, seq: 0, data: "start", complete: false });
    // Sequence 1 never arrives. Joining 0 and 2 would produce a body that parses and is wrong.
    bridge.deliver({ t: "agent-http-chunk", rid, seq: 2, data: "end", complete: true });

    await expect(pending).rejects.toThrow(/chunk 2 arrived, expected 1/);
  });

  it("delivers one subscription message per completed chunk run", () => {
    const bridge = new FakeHostBridge();
    const transport = new RelayHttpTransport(bridge);
    const messages: string[] = [];
    let opened: number | null = null;

    transport.subscribe("/api/inventory/stream", {
      onOpen: (status) => {
        opened = status;
      },
      onMessage: (payload) => messages.push(payload),
      onError: () => {},
    });
    const sent = lastRequest(bridge);
    expect(sent.stream).toBe(true);

    bridge.deliver({ t: "agent-http-head", rid: sent.rid, status: 200 });
    bridge.deliver({ t: "agent-http-chunk", rid: sent.rid, seq: 0, data: "first", complete: true });
    bridge.deliver({ t: "agent-http-chunk", rid: sent.rid, seq: 1, data: "sec", complete: false });
    bridge.deliver({ t: "agent-http-chunk", rid: sent.rid, seq: 2, data: "ond", complete: true });

    expect(opened).toBe(200);
    // Without the boundary flag these four chunks would read as four messages, and a reader
    // could not tell a split message from two.
    expect(messages).toEqual(["first", "second"]);
  });

  it("cancels a subscription and ignores the frames still in flight for it", () => {
    const bridge = new FakeHostBridge();
    const transport = new RelayHttpTransport(bridge);
    const messages: string[] = [];

    const stop = transport.subscribe("/api/inventory/stream", {
      onMessage: (payload) => messages.push(payload),
      onError: () => {
        throw new Error("a cancelled subscription must not report an error");
      },
    });
    const { rid } = lastRequest(bridge);
    stop();

    expect(bridge.posted.at(-1)).toEqual({ t: "agent-http-cancel", rid });
    bridge.deliver({ t: "agent-http-chunk", rid, seq: 0, data: "late", complete: true });
    expect(messages).toEqual([]);
  });

  it("reports the relay's own failure to the caller", async () => {
    const bridge = new FakeHostBridge();
    const transport = new RelayHttpTransport(bridge);

    const pending = transport.request("GET", "/api/etc");
    const { rid } = lastRequest(bridge);
    bridge.deliver({ t: "agent-http-err", rid, reason: "path not allowed" });

    await expect(pending).rejects.toThrow("path not allowed");
  });

  it("fails everything in flight when disposed, so nothing waits forever", async () => {
    const bridge = new FakeHostBridge();
    const transport = new RelayHttpTransport(bridge);

    const pending = transport.request("GET", "/api/config");
    transport.dispose();

    await expect(pending).rejects.toThrow("transport disposed");
  });

  it("leaves frames for the host's own protocol alone", () => {
    const bridge = new FakeHostBridge();
    const transport = new RelayHttpTransport(bridge);
    transport.subscribe("/api/inventory/stream", {
      onMessage: () => {
        throw new Error("a native-authority reply is not a relay frame");
      },
      onError: () => {
        throw new Error("a native-authority reply is not a relay frame");
      },
    });

    // The same channel carries these; HostActionsClient reads them.
    bridge.deliver({ t: "agent-window-input-status", sub: "window-input-1", tx: "draft" });
    bridge.deliver({ t: "agent-terminal-ready", rid: "request-1" });
  });
});
