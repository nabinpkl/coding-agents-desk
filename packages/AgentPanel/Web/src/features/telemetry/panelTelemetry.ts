// How this page's loads are measured, and its errors kept: Sentry's React SDK (its browser SDK
// plus React's error hooks), sending nothing to Sentry. Every
// envelope goes through `tunnel` to the sidecar's `/api/telemetry/envelope`, which archives it
// under a byte cap and hands a copy to Spotlight (`agent-feed/sidecar/src/telemetry/`).
//
// The DSN is a placeholder on a reserved domain, never contacted, because `tunnel` replaces where
// envelopes go. It has to be there: without one the SDK counts itself disabled, and a disabled
// client attaches no trace headers -- which is how the sidecar's half of a trace went missing.
//
// What a load records, without code of ours: the navigation's phases and Web Vitals, a span per
// resource the page fetched (scripts cut to a count and the slowest few, `scriptSpanSummary.ts`),
// long animation frames, and a span per `fetch`. The `fetch` spans carry
// trace headers to `/api`, so the sidecar's handling of each request lands in the same trace.
// What only this panel knows -- its milestones and its streams -- is in `pageMilestones.ts`, and
// what it holds in memory, at the load's end and every twenty minutes after, in `pageMemory.ts`.

import {
  browserTracingIntegration,
  getCurrentScope,
  init,
  reactErrorHandler,
  spanToJSON,
  userTimingIntegration,
} from "@sentry/react";
import type { RootOptions } from "react-dom/client";
import { pageMemoryAttributes, startPageMemorySamples } from "@/features/telemetry/pageMemory";
import { awaitMilestones } from "@/features/telemetry/pageMilestones";
import { summarizeScriptSpans } from "@/features/telemetry/scriptSpanSummary";

const TELEMETRY_ROUTE = "/api/telemetry/envelope";

/** `.invalid` is reserved never to resolve (RFC 2606), so this can never become a destination. */
const LOCAL_DSN = "https://local@telemetry.invalid/0";

/**
 * How long a page load may stay open waiting for its milestones. Generous on purpose: the loads
 * worth reading are the slow ones, and the SDK's 30 seconds would end exactly those early.
 */
const LOAD_LIMIT_MS = 60_000;

/**
 * Every root's error hooks. React 19 reports an error a boundary caught to the console only, and
 * every surface sits under `PanelErrorBoundary`, so the SDK's global handlers never saw a render
 * error at all. The other two reached the window, but without the component stack this carries.
 * With no client installed (fixture, native container) the capture is a no-op and the console line
 * is all that remains: the boundary logs what it catches, so only the other two log here, in place
 * of the React defaults they replace.
 */
export const panelRootOptions: RootOptions = {
  onCaughtError: reactErrorHandler(),
  onUncaughtError: reactErrorHandler((error, info) => {
    console.error("[panel] uncaught render error", error, info.componentStack);
  }),
  onRecoverableError: reactErrorHandler((error, info) => {
    console.error("[panel] React recovered from", error, info.componentStack);
  }),
};

export function installPanelTelemetry(): void {
  const client = init({
    dsn: LOCAL_DSN,
    tunnel: TELEMETRY_ROUTE,
    // Whole transactions, not SDK 11's default of streamed spans: Spotlight 4.12 lists the streamed
    // kind as envelopes and draws no trace from them.
    traceLifecycle: "static",
    // Page loads, and the Web Vitals the browser reports after one (CLS, INP), which arrive as
    // `ui.` spans of their own. Not every request the panel makes afterwards: a page left open
    // for a day would bury its load under a trace per `fetch`, and the sidecar only joins traces
    // sampled here. Judged by the span alone, NOT by `parentSampled`: the page keeps its load's
    // trace for as long as it is open, so every later request reads as that trace's sampled
    // child. What runs inside the load is a real child and never reaches this.
    tracesSampler: ({ attributes }) => {
      const op = attributes?.["sentry.op"];
      return op === "pageload" || (typeof op === "string" && op.startsWith("ui."));
    },
    integrations: [
      browserTracingIntegration({
        // The panel moves between views with `replaceState`, which is not a page the reader
        // navigated to; a trace per view switch would bury the loads.
        instrumentNavigation: false,
        finalTimeout: LOAD_LIMIT_MS,
        childSpanTimeout: LOAD_LIMIT_MS,
      }),
      // Ours only. React's development build writes its own measures ("Update", "Cascading
      // Update") by the hundred, and they would bury the milestones.
      userTimingIntegration({ ignore: [/^(?!panel |stream )/] }),
      // A dev load's ~380 module fetches, as a count and the slowest ten (`scriptSpanSummary.ts`).
      { name: "ScriptSpanSummary", processEvent: summarizeScriptSpans },
    ],
  });
  // Once the load is over, the page moves to a trace nobody samples. Left on the load's, every
  // `/api` request for as long as the page stays open carries a sampled trace header, and the
  // sidecar records each one as part of a load that ended hours ago. On `beforeIdleSpanEnd`, after
  // the SDK's own handler there, which is what puts the load's sampled trace on the scope.
  client?.on("beforeIdleSpanEnd", (span) => {
    if (spanToJSON(span).attributes?.["sentry.op"] !== "pageload") return;
    // What the page holds once it has loaded (`pageMemory.ts`).
    span.setAttributes(pageMemoryAttributes());
    getCurrentScope().setPropagationContext({
      traceId: crypto.randomUUID().replaceAll("-", ""),
      sampleRand: Math.random(),
      sampled: false,
    });
  });
  if (client) startPageMemorySamples();
  // The canvas is the surface being read (AGENTS.md), and the one whose load these describe.
  if (new URLSearchParams(window.location.search).get("view") === "canvas") {
    awaitMilestones(["first-card"]);
  }
}
