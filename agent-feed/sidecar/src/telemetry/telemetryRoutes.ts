// `POST /api/telemetry/envelope` -- the panel's Sentry envelopes, on their way to the archive and
// Spotlight.
//
// The panel's SDK sends nothing to Sentry: its `tunnel` is this route. Here rather than straight to
// Spotlight, because a page on the phone cannot reach a Spotlight on this Mac's loopback, this
// origin is the one every surface already reaches, and the archive lives on this side.

import type { RouteHandler } from "@/http/protocol/route";
import type { TelemetrySource } from "@/telemetry/telemetryArchive";

export const TELEMETRY_ROUTE = "/api/telemetry/envelope";

/** Far above a page load with every resource span on it; a body this size is not an envelope. */
const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;

/** The envelope's header line, which every envelope has, or a reason it is refused. */
export function envelopeRefusal(body: string): string | null {
  if (body.length === 0) return "empty body";
  const newline = body.indexOf("\n");
  try {
    const header: unknown = JSON.parse(newline === -1 ? body : body.slice(0, newline));
    if (header === null || typeof header !== "object" || Array.isArray(header))
      return "envelope header is not an object";
  } catch {
    return "envelope header is not JSON";
  }
  return null;
}

export function createTelemetryRoutes(sink: (source: TelemetrySource, envelope: string) => void): RouteHandler {
  return (request, url) => {
    if (request.method !== "POST" || url.pathname !== TELEMETRY_ROUTE) return undefined;
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_ENVELOPE_BYTES) return new Response("envelope too large", { status: 413 });
    return request.text().then((body) => {
      if (body.length > MAX_ENVELOPE_BYTES) return new Response("envelope too large", { status: 413 });
      const refusal = envelopeRefusal(body);
      if (refusal) return new Response(refusal, { status: 400 });
      sink("panel", body);
      return new Response(null, { status: 200 });
    });
  };
}
