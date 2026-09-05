import { describe, expect, it, vi } from "vitest";
import { sessionPath, sessionTransport } from "./SessionTransport";
import type { AgentHttpTransport } from "./AgentHttpTransport";

describe("sessionPath", () => {
  it("leaves the default session's paths exactly as they were", () => {
    expect(sessionPath(undefined, "/api/config")).toBe("/api/config");
  });

  it("addresses another session through its own prefix", () => {
    expect(sessionPath("agent", "/api/config")).toBe("/session/agent/api/config");
    expect(sessionPath("agent", "/api/park/tile/display/webrtc")).toBe(
      "/session/agent/api/park/tile/display/webrtc",
    );
  });

  it("does not touch a path that was never a sidecar call", () => {
    expect(sessionPath("agent", "/session/index.json")).toBe("/session/index.json");
    expect(sessionPath("agent", "/assets/x.js")).toBe("/assets/x.js");
  });
});

describe("sessionTransport", () => {
  const base = (): AgentHttpTransport => ({
    request: vi.fn().mockResolvedValue({ status: 200, body: "{}" }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  });

  it("returns the transport itself for the default session, so the relay path is unchanged", () => {
    const inner = base();
    expect(sessionTransport(inner)).toBe(inner);
  });

  it("rewrites both verbs onto the named session", async () => {
    const inner = base();
    const wrapped = sessionTransport(inner, "agent");
    await wrapped.request("GET", "/api/config");
    wrapped.subscribe("/api/stream", { onMessage: () => {}, onError: () => {} });
    expect(inner.request).toHaveBeenCalledWith("GET", "/session/agent/api/config", undefined);
    expect(inner.subscribe).toHaveBeenCalledWith("/session/agent/api/stream", expect.anything());
  });

  it("carries the options through untouched", async () => {
    const inner = base();
    const signal = new AbortController().signal;
    await sessionTransport(inner, "agent").request("POST", "/api/x", { body: { a: 1 }, signal });
    expect(inner.request).toHaveBeenCalledWith("POST", "/session/agent/api/x", { body: { a: 1 }, signal });
  });
});
