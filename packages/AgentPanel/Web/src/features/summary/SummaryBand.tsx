"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { SummaryResult } from "@agentdesk/agent-feed-wire";
import type { SummaryState } from "./useSummary";

/**
 * The digest, above the composer.
 *
 * Not rows in the feed. `ActivityFeed` is the thread's only scroll owner, and injecting
 * synthetic rows would put this in a fight with tail-follow, sticky headers and virtualization
 * for no gain -- the digest is about the turn, not a part of it.
 */
export function SummaryBand({
  state,
  model,
  onDismiss,
}: {
  state: SummaryState;
  model: string | null;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  if (state.kind === "idle") return null;

  return (
    <section
      aria-label="Turn summary"
      className="shrink-0 border-t border-border bg-card px-3 py-2 text-(length:--agent-panel-fs-sidebar-body,15px)"
    >
      {state.kind === "pending" ? (
        <p className="text-muted-foreground" aria-live="polite">
          Reading the turn and the working tree…
        </p>
      ) : state.kind === "error" ? (
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-destructive" role="alert">{state.message}</p>
          <DismissButton onDismiss={onDismiss} />
        </div>
      ) : (
        <Digest
          result={state.result}
          model={model}
          expanded={expanded}
          onToggle={() => setExpanded((open) => !open)}
          onDismiss={onDismiss}
        />
      )}
    </section>
  );
}

function Digest({
  result,
  model,
  expanded,
  onToggle,
  onDismiss,
}: {
  result: SummaryResult;
  model: string | null;
  expanded: boolean;
  onToggle: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-start gap-1.5 rounded text-left text-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {expanded
            ? <ChevronDown className="mt-0.5 size-4 shrink-0" aria-hidden />
            : <ChevronRight className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <span className="min-w-0 font-semibold">{result.headline}</span>
        </button>
        {/* Said plainly rather than styled as a warning: a digest of a turn still in flight is
            the intended use, not a degraded one. */}
        {result.phase === "running" ? (
          <span className="mt-0.5 shrink-0 rounded bg-primary/20 px-1.5 py-0.5 text-xs text-primary">
            still running
          </span>
        ) : null}
        <DismissButton onDismiss={onDismiss} />
      </div>

      {expanded ? (
        <div className="flex flex-col gap-2 pl-5.5">
          <p className="whitespace-pre-wrap text-muted-foreground">{result.narrative}</p>

          {result.filesTouched.length > 0 ? (
            <ul className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
              {result.filesTouched.map((file) => (
                <li key={file.path} className="flex gap-2">
                  <span className="w-4 shrink-0 text-foreground">{file.status}</span>
                  <span className="min-w-0 truncate">{file.path}</span>
                  {file.added || file.removed ? (
                    <span className="shrink-0">+{file.added} −{file.removed}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {result.risks.length > 0 ? (
            <ul className="flex list-disc flex-col gap-0.5 pl-4 text-muted-foreground">
              {result.risks.map((risk) => <li key={risk}>{risk}</li>)}
            </ul>
          ) : null}

          {/* Provenance, not decoration: a digest is only as trustworthy as what wrote it, and
              a truncated window is a claim about coverage the viewer has to be able to see. */}
          <p className="text-xs text-muted-foreground">
            {model ? `${model} · ` : ""}
            events {result.coverage.fromEventIndex}–{result.coverage.toEventIndex}
            {result.coverage.truncated ? " · window truncated, the middle of this turn was not read" : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Dismiss summary"
      title="Dismiss summary"
      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <X className="size-4" aria-hidden />
    </button>
  );
}
