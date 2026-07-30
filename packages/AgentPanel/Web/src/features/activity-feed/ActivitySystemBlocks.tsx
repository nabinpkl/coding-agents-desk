"use client";

import { useCallback, useState } from "react";
import type { SessionReference } from "./data-source/AgentDataSource";
import { useDataSource } from "./data-source/AgentDataSourceContext";
import type { ActivityBlock } from "./useSessionEventsStream";

/**
 * A collapsed transcript drawer, sized as a chip.
 *
 * `display: list-item` stays: an `inline-flex` or `flex` summary drops the
 * disclosure triangle in WebKit, and the triangle is the only thing marking
 * these as openable.
 */
const DRAWER_CLASS = "text-(length:--agent-panel-fs-tile-chip,12px)";
const DRAWER_SUMMARY_CLASS =
  "cursor-pointer py-0.5 font-mono leading-none text-muted-foreground hover:text-foreground";

export function LabeledTextBlock({ block }: { block: ActivityBlock }) {
  return (
    <div className="rounded-sm border border-border/60 bg-card/50">
      <div
        className="border-b border-border/50 px-2 py-1 font-mono font-semibold text-foreground/70"
        style={{ fontSize: "var(--agent-panel-fs-tile-chip, 12px)" }}
      >
        {block.label ?? (block.kind === "plain" ? "Plain" : "Metadata")}
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-foreground/75">
        {block.text ?? ""}
      </pre>
    </div>
  );
}

/**
 * One collapsed drawer per transcript line holding everything that is not the
 * line's content: its metadata blocks and, nested one level deeper, the exact
 * raw line. Nesting keeps Raw JSON's lazy fetch intact -- opening this drawer
 * costs nothing until the inner disclosure is opened too.
 *
 * A tool call that absorbed its result shows two of these, one per source
 * line, so `label` distinguishes them.
 */
export function RawDetails({
  metadata,
  session,
  eventIndex,
  includesRawJson,
  label = "Raw",
}: {
  metadata: ActivityBlock[];
  /** Carries the mode alongside the identity, because `eventIndex` is counted in
   *  it: the same integer names a different line in the other view, so the two
   *  cannot travel separately. */
  session: SessionReference;
  eventIndex: number;
  includesRawJson: boolean;
  label?: string;
}) {
  if (metadata.length === 0 && !includesRawJson) return null;
  return (
    // Closed, this is plumbing, so it gets a chip's worth of space rather than a
    // bordered full-width band: four of these were spending 97px of a 535px
    // viewport on drawers nobody had opened. The border moves to the open body,
    // where there is actually something to enclose.
    <details className={DRAWER_CLASS}>
      <summary className={DRAWER_SUMMARY_CLASS}>{label}</summary>
      <div className="mt-1 space-y-1.5 rounded-sm border border-border/50 bg-muted/20 p-1.5">
        {metadata.map((block, index) => (
          <LabeledTextBlock key={index} block={block} />
        ))}
        {includesRawJson ? (
          <RawJsonBlock session={session} eventIndex={eventIndex} />
        ) : null}
      </div>
    </details>
  );
}

export function RawJsonBlock({
  session,
  eventIndex,
}: {
  session: SessionReference;
  eventIndex: number;
}) {
  const dataSource = useDataSource();
  const [raw, setRaw] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (raw !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      setRaw(await dataSource.fetchRawEvent(session, eventIndex));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "raw event fetch failed");
    } finally {
      setLoading(false);
    }
  }, [dataSource, eventIndex, loading, raw, session]);

  return (
    <details
      className={DRAWER_CLASS}
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary className={DRAWER_SUMMARY_CLASS}>Raw JSON</summary>
      {loading ? <div className="py-1 text-muted-foreground">Loading…</div> : null}
      {error ? <div className="py-1 text-destructive">{error}</div> : null}
      {raw !== null ? (
        <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border/50 bg-muted/20 px-2 py-1.5 font-mono text-foreground/75">
          {raw}
        </pre>
      ) : null}
    </details>
  );
}
