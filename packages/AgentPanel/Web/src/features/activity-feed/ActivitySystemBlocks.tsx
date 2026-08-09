"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { SessionReference } from "./data-source/AgentDataSource";
import { useDataSource } from "./data-source/AgentDataSourceContext";
import { SHIKI_THEMES, useHighlighter } from "./markdown/highlighter";
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

/**
 * Pretty-print a raw transcript line when it is JSON, untouched otherwise.
 *
 * Raw lines are compact JSONL, but not every line parses (plain events,
 * non-JSON payloads), so a parse failure falls back to the exact text. The
 * server-side raw cap is 100 MiB per event (`MAX_RAW_EVENT_BYTES`); formatting
 * a blob that large on the phone would freeze the webview, so anything past
 * `RAW_JSON_FORMAT_MAX_CHARS` stays as fetched.
 */
export const RAW_JSON_FORMAT_MAX_CHARS = 512_000;

export function formatRawJson(text: string): string {
  if (text.length > RAW_JSON_FORMAT_MAX_CHARS) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2) ?? text;
  } catch {
    return text;
  }
}

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

  const pretty = useMemo(() => (raw !== null ? formatRawJson(raw) : null), [raw]);
  const hl = useHighlighter();
  const html = useMemo(() => {
    if (!hl || pretty === null) return null;
    try {
      return hl.codeToHtml(pretty, {
        lang: "json",
        themes: SHIKI_THEMES,
        defaultColor: false,
      });
    } catch {
      return null;
    }
  }, [hl, pretty]);

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
      {pretty !== null ? (
        <div className="mt-1 rounded-sm border border-border/50 bg-muted/20">
          <div className="flex items-center justify-between gap-2 border-b border-border/50 px-2 py-0.5">
            <span className="font-mono text-foreground/60">json</span>
            <CopyButton text={pretty} />
          </div>
          {/* The drawer sits inside an already-open <details>, so the
              plain/Shiki swap changes no measured row height. The body
              wrapper reuses the code-block classes so the dual-theme token
              colors and the scroll container come along unchanged. */}
          {html ? (
            <div
              className="agent-panel-code__body max-h-80"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-foreground/75">
              {pretty}
            </pre>
          )}
        </div>
      ) : null}
    </details>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded-sm px-1 py-0.5 font-mono text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
      aria-label={copied ? "Copied" : "Copy raw JSON"}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check className="size-[1em]" aria-hidden /> : <Copy className="size-[1em]" aria-hidden />}
      {copied ? "copied" : "copy"}
    </button>
  );
}
