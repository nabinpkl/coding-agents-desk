"use client";

import { useCallback, useState } from "react";
import type { AgentSource } from "./data-source/AgentDataSource";
import { useDataSource } from "./data-source/AgentDataSourceContext";
import type { ActivityBlock } from "./useSessionEventsStream";

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
  source,
  sessionId,
  eventIndex,
  includesRawJson,
  label = "Raw",
}: {
  metadata: ActivityBlock[];
  source: AgentSource;
  sessionId: string;
  eventIndex: number;
  includesRawJson: boolean;
  label?: string;
}) {
  if (metadata.length === 0 && !includesRawJson) return null;
  return (
    <details className="rounded-sm border border-border/50 bg-muted/20">
      <summary className="cursor-pointer px-2 py-1 font-mono text-foreground/65">
        {label}
      </summary>
      <div className="space-y-1.5 border-t border-border/50 p-1.5">
        {metadata.map((block, index) => (
          <LabeledTextBlock key={index} block={block} />
        ))}
        {includesRawJson ? (
          <RawJsonBlock
            source={source}
            sessionId={sessionId}
            eventIndex={eventIndex}
          />
        ) : null}
      </div>
    </details>
  );
}

export function RawJsonBlock({
  source,
  sessionId,
  eventIndex,
}: {
  source: AgentSource;
  sessionId: string;
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
      setRaw(await dataSource.fetchRawEvent({ source, sessionId }, eventIndex));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "raw event fetch failed");
    } finally {
      setLoading(false);
    }
  }, [dataSource, eventIndex, loading, raw, sessionId, source]);

  return (
    <details
      className="rounded-sm border border-border/50 bg-muted/20"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary className="cursor-pointer px-2 py-1 font-mono text-foreground/65">
        Raw JSON
      </summary>
      {loading ? <div className="px-2 py-1 text-muted-foreground">Loading…</div> : null}
      {error ? <div className="px-2 py-1 text-destructive">{error}</div> : null}
      {raw !== null ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-border/50 px-2 py-1.5 font-mono text-foreground/75">
          {raw}
        </pre>
      ) : null}
    </details>
  );
}
