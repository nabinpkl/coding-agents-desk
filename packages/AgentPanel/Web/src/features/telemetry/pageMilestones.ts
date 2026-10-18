// The points in a page load that only this panel can name -- the first Bot card on the canvas,
// the first transcript rows on a card, each stream's first message -- recorded as standard
// `performance.measure` entries from the start of the page.
//
// Sentry's user-timing integration turns these into spans of the page-load trace, but only those
// that exist when that trace ends, and it ends on the first idle second. So a load that expects
// milestones holds it open with a "panel ready" span until the last one arrives, bounded by the
// page-load limit in `panelTelemetry.ts`. A milestone never reached leaves that span cancelled,
// which is itself the finding: the canvas never showed what it was waiting for.
//
// Only what the page is certain to show is awaited up front. A canvas need not have a session
// open, so rows are awaited from the moment a transcript mounts (`expectMilestone`), not before:
// awaiting them on a canvas with none open held every such load for the whole limit.

import { startInactiveSpan, type Span } from "@sentry/react";

export type Milestone = "first-card" | "first-rows";

const reached = new Set<Milestone>();
const measuredStreams = new Set<string>();
let waiting: { pending: Set<Milestone>; span: Span } | null = null;

/** Holds the page-load trace open until each of these has been reached. */
export function awaitMilestones(names: readonly Milestone[]): void {
  const pending = new Set(names.filter((name) => !reached.has(name)));
  if (pending.size === 0) return;
  waiting = {
    pending,
    span: startInactiveSpan({ name: "panel ready", op: "ui.load", startTime: performance.timeOrigin }),
  };
}

/** Adds one to what the page load is waiting for, while it still is. */
export function expectMilestone(name: Milestone): void {
  if (waiting && !reached.has(name)) waiting.pending.add(name);
}

/** The first time only; a card mounting again later is not the page loading. */
export function reachMilestone(name: Milestone): void {
  if (reached.has(name)) return;
  reached.add(name);
  measureFromStart(`panel ${name}`, performance.now());
  if (!waiting?.pending.delete(name) || waiting.pending.size > 0) return;
  waiting.span.end();
  waiting = null;
}

/**
 * From a stream being opened to its first message, once per stream path. The query is dropped: it
 * names what was asked for, and the path already says which stream it was.
 */
export function measureStreamFirstMessage(path: string, openedAt: number): void {
  const stream = path.split("?")[0]!;
  if (measuredStreams.has(stream)) return;
  measuredStreams.add(stream);
  performance.measure(`stream ${stream}`, { start: openedAt, end: performance.now() });
}

function measureFromStart(name: string, end: number): void {
  performance.measure(name, { start: 0, end });
}

/** For tests: forget what this page has reached. */
export function resetMilestones(): void {
  reached.clear();
  measuredStreams.clear();
  waiting = null;
}
