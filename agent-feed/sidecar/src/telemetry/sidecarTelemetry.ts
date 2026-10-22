// This process's half of the panel's traces, and its own errors, recorded with the Sentry SDK and
// kept on this machine.
//
// Imported first by `server.ts`, so the SDK is set up before anything it should see. Nothing is
// sent to Sentry: the transport hands every envelope to `telemetrySink.ts` (the archive, then
// Spotlight). The DSN is a placeholder on a reserved domain, never contacted -- the SDK needs one
// to count itself enabled, and a disabled client neither sends nor joins a trace.
//
// What is traced is narrow on purpose:
//   - A request carrying a SAMPLED `sentry-trace` header, which only the panel's own traced page
//     load sends. It becomes a span under that page's trace, so a slow `/api/bots` reads as a
//     child of the load that waited on it. Everything else -- a tile's frame pulls, the host's
//     probes, the panel's requests after its load -- passes through untouched and synchronously.
//   - This process's own start, from the moment Bun started it to the moment it listens.
//   - Its memory, once it listens and every five minutes after (`sidecarMemory.ts`).
//
// `Bun.serve` instrumentation from the SDK's defaults is NOT used: it wraps every request in an
// async handler, WebSocket upgrades and hours-long streams included, and records all of them.
//
// Crash behaviour is unchanged. Bun exits on an uncaught exception and on an unhandled rejection;
// the SDK records either, flushes, and exits the same way (`mode: "strict"` for rejections).

import * as Sentry from "@sentry/bun";
import { createTransport } from "@sentry/core";
import { MEMORY_SPAN, startProcessMemorySamples } from "@/telemetry/sidecarMemory";
import { sinkEnvelope } from "@/telemetry/telemetrySink";
import { TELEMETRY_ROUTE } from "@/telemetry/telemetryRoutes";

const BOOT = "sidecar boot";

/** `.invalid` is reserved never to resolve (RFC 2606), so this can never become a destination. */
const LOCAL_DSN = "https://local@telemetry.invalid/0";

Sentry.initWithoutDefaultIntegrations({
  dsn: LOCAL_DSN,
  // Whole transactions, not SDK 11's default of streamed spans: Spotlight 4.12 lists the streamed
  // kind as envelopes and draws no trace from them.
  traceLifecycle: "static",
  transport: (options) =>
    createTransport(options, async ({ body }) => {
      sinkEnvelope("sidecar", typeof body === "string" ? body : new TextDecoder().decode(body));
      return { statusCode: 200 };
    }),
  // Join the panel's decision when there is one; otherwise only this process's start and its
  // memory readings are recorded.
  tracesSampler: ({ name, parentSampled }) => parentSampled ?? (name === BOOT || name === MEMORY_SPAN),
  integrations: [
    Sentry.functionToStringIntegration(),
    Sentry.linkedErrorsIntegration(),
    Sentry.dedupeIntegration(),
    Sentry.onUncaughtExceptionIntegration(),
    Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
  ],
});

// From the moment Bun started this process, which is what `performance.timeOrigin` is here.
const boot = Sentry.startInactiveSpan({ name: BOOT, op: "app.start", startTime: performance.timeOrigin });

/** Called once the server is listening. */
export function sidecarListening(): void {
  boot.end();
  startProcessMemorySamples();
}

/** A sampled trace header: `<trace>-<span>-1`. Unsampled or absent means the page is not tracing. */
const SAMPLED = /^[0-9a-f]{32}-[0-9a-f]{16}-1$/;

/** Runs a request's handler, under a span of the panel's trace when the request is part of one. */
export function traceRequest<T extends Response | undefined>(
  request: Request,
  url: URL,
  handle: () => T | Promise<T>,
): T | Promise<T> {
  const sentryTrace = request.headers.get("sentry-trace");
  if (
    !sentryTrace ||
    !SAMPLED.test(sentryTrace) ||
    url.pathname === TELEMETRY_ROUTE ||
    request.headers.has("upgrade")
  ) {
    return handle();
  }
  const baggage = request.headers.get("baggage") ?? undefined;
  return Sentry.continueTrace({ sentryTrace, baggage }, () =>
    Sentry.startSpan(
      {
        name: `${request.method} ${url.pathname}`,
        op: "http.server",
        attributes: { "http.request.method": request.method, "url.path": url.pathname },
      },
      // Ends when the handler has a response, not when its body does: a stream's span is the time
      // to its first byte rather than the hours it stays open.
      async (span) => {
        const response = await handle();
        if (response) Sentry.setHttpStatus(span, response.status);
        return response;
      },
    ),
  );
}
