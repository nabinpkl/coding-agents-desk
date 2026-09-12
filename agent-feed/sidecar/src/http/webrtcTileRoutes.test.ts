import { describe, expect, test } from "bun:test";
import {
  createWebrtcTileRoutes,
  webrtcSessionsSnapshot,
} from "./webrtcTileRoutes.ts";

const server = undefined as never;
const diagnostics: string[] = [];
const route = createWebrtcTileRoutes((line) => diagnostics.push(line));

function telemetry(body: unknown): Promise<Response> {
  const url = new URL("http://127.0.0.1/api/park/tile/display/webrtc/telemetry");
  const request = new Request(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return Promise.resolve(route(request, url, server)!);
}

describe("WebRTC tile telemetry", () => {
  test("accepts bounded video presentation evidence from TypeScript", async () => {
    const response = await telemetry({
      attempt: "31e283bb-213e-4f22-89ca-e98d8e25c28a",
      phase: "video-presentation",
      detail: JSON.stringify({
        event: "sample",
        readyState: 4,
        video: "1320x856",
        trackState: "live",
        lastPresentedAgeMs: 31,
      }),
      elapsedMs: 5_000,
    });

    expect(response.status).toBe(204);
    expect(diagnostics.at(-1)).toContain('"phase":"video-presentation"');
    expect(diagnostics.at(-1)).toContain('\\"trackState\\":\\"live\\"');
  });

  test("accepts detailed presentation-gap evidence and still bounds the log line", async () => {
    const response = await telemetry({
      attempt: "31e283bb-213e-4f22-89ca-e98d8e25c28a",
      phase: "presentation-gap",
      detail: `${JSON.stringify({
        event: "detected",
        gapMs: 1_203,
        progress: "source-or-network-silent",
      })}${"x".repeat(4_096)}`,
      elapsedMs: 5_000,
    });

    expect(response.status).toBe(204);
    expect(diagnostics.at(-1)).toContain('"phase":"presentation-gap"');
    expect(diagnostics.at(-1)!.length).toBeLessThan(2_300);
  });

  test("accepts bounded viewport gesture lifecycle events from TypeScript", async () => {
    const started = await telemetry({
      attempt: "31e283bb-213e-4f22-89ca-e98d8e25c28a",
      phase: "viewport-gesture-start",
      detail: JSON.stringify({ kind: "pinch-pan", scale: 1 }),
      elapsedMs: 0,
    });
    const ended = await telemetry({
      attempt: "31e283bb-213e-4f22-89ca-e98d8e25c28a",
      phase: "viewport-gesture-end",
      detail: JSON.stringify({ kind: "pinch-pan", scale: 1.25, tx: -100, ty: -62.5 }),
      elapsedMs: 412,
    });

    expect(started.status).toBe(204);
    expect(ended.status).toBe(204);
    expect(diagnostics.at(-2)).toContain('"phase":"viewport-gesture-start"');
    expect(diagnostics.at(-1)).toContain('"phase":"viewport-gesture-end"');
  });

  test("accepts privacy-bounded desktop keyboard and ownership evidence", async () => {
    const phases = [
      "control-channel-state",
      "control-ownership",
      "keyboard-state",
      "keyboard-focus-result",
      "keyboard-input-applied",
      "keyboard-input-rejected",
      "keyboard-buffer-overflow",
    ];
    for (const phase of phases) {
      const response = await telemetry({
        attempt: "31e283bb-213e-4f22-89ca-e98d8e25c28a",
        phase,
        detail: JSON.stringify({ requestId: "request", count: 2, secure: true }),
        elapsedMs: 700,
      });
      expect(response.status).toBe(204);
      expect(diagnostics.at(-1)).toContain(`\"phase\":\"${phase}\"`);
    }
  });

  test("still rejects telemetry phases outside the explicit contract", async () => {
    const response = await telemetry({
      attempt: "31e283bb-213e-4f22-89ca-e98d8e25c28a",
      phase: "arbitrary-console-log",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "webrtc-bad-telemetry",
      message: "invalid attempt or phase",
    });
  });
});

describe("WebRTC sessions", () => {
  function sessions(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    const url = new URL(`http://127.0.0.1${path}`);
    const request = new Request(url.toString(), {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return Promise.resolve(route(request, url, server)!);
  }

  test("lists nothing while no viewer or encoder is live", async () => {
    const response = await sessions("GET", "/api/park/webrtc/sessions");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connections: [], encoders: [] });
    expect(webrtcSessionsSnapshot()).toEqual({ connections: [], encoders: [] });
  });

  test("closing is idempotent and reports what it found", async () => {
    const response = await sessions("POST", "/api/park/webrtc/sessions/close", { attempt: "no-such-attempt" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ closedConnections: [], stoppedEncoders: [] });
    const all = await sessions("POST", "/api/park/webrtc/sessions/close", { all: true });
    expect(await all.json()).toEqual({ closedConnections: [], stoppedEncoders: [] });
  });

  test("a close that names nothing, or names it badly, is refused", async () => {
    expect((await sessions("POST", "/api/park/webrtc/sessions/close", {})).status).toBe(400);
    expect((await sessions("POST", "/api/park/webrtc/sessions/close", { attempt: "bad attempt!" })).status).toBe(400);
    expect((await sessions("POST", "/api/park/webrtc/sessions/close", { encoderPid: "12" })).status).toBe(400);
  });
});
