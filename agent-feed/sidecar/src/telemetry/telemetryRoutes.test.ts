// The panel's envelopes arrive here. What matters is that one reaches the sink as the panel's, and
// that a body which is not an envelope is refused rather than archived.

import { expect, test } from "bun:test";
import { createTelemetryRoutes, TELEMETRY_ROUTE } from "@/telemetry/telemetryRoutes";

function post(body: string, path = TELEMETRY_ROUTE, headers: Record<string, string> = {}) {
  const sunk: [string, string][] = [];
  const url = new URL(`http://127.0.0.1${path}`);
  const request = new Request(url.href, { method: "POST", body, headers });
  const response = createTelemetryRoutes((source, envelope) => sunk.push([source, envelope]))(
    request,
    url,
    undefined as never,
  );
  return { response, sunk };
}

test("sinks an envelope as the panel's, verbatim", async () => {
  const envelope = `{"sent_at":"2026-10-14T00:00:00Z"}\n{"type":"span"}\n{"version":2,"items":[]}`;
  const { response, sunk } = post(envelope);
  expect((await response)!.status).toBe(200);
  expect(sunk).toEqual([["panel", envelope]]);
});

test("refuses a body whose first line is not an envelope header, and sinks nothing", async () => {
  for (const body of ["", "hello", "[1,2]\n{}"]) {
    const { response, sunk } = post(body);
    expect((await response)!.status).toBe(400);
    expect(sunk).toEqual([]);
  }
});

test("refuses a declared body too large to be an envelope before reading it", async () => {
  const { response } = post("{}", TELEMETRY_ROUTE, { "content-length": String(64 * 1024 * 1024) });
  expect((await response)!.status).toBe(413);
});

test("leaves every other path to the routes after it", () => {
  expect(post("{}", "/api/config").response).toBeUndefined();
});
