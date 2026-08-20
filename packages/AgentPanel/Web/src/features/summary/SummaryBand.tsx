"use client";

import { useEffect, useRef, useState } from "react";
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
  const band = useRef<HTMLElement>(null);
  const pendingLength = state.kind === "pending"
    ? state.reasoning.length + state.thought.length
    : 0;

  // Follows the run while it is running, and only then. The band is short and the newest line is
  // the one being written, so a viewer watching it should not have to chase it downward; once
  // the digest lands, the top of it is what they want to read, so this stops.
  useEffect(() => {
    if (pendingLength === 0 || !band.current) return;
    band.current.scrollTop = band.current.scrollHeight;
  }, [pendingLength]);

  if (state.kind === "idle") return null;

  return (
    <section
      ref={band}
      aria-label="Turn summary"
      // Capped and scrolled inside itself. Measured on a real digest: thirteen changed files
      // plus risks came to 731px against a 720px pane, so the band pushed the transcript it was
      // describing entirely off screen. It is a note about the thread, never a replacement for
      // it, and the trace below only makes a long digest longer.
      className="max-h-[45vh] shrink-0 overflow-y-auto border-t border-border bg-card px-3 py-2 text-(length:--agent-panel-fs-sidebar-body,15px)"
    >
      {state.kind === "pending" ? (
        <RunInProgress reasoning={state.reasoning} thought={state.thought} onDismiss={onDismiss} />
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
                  <span className="w-12 shrink-0 text-foreground">{file.action}</span>
                  <span className="min-w-0 truncate">{file.path}</span>
                  {file.added || file.removed ? (
                    <span className="shrink-0">+{file.added} −{file.removed}</span>
                  ) : null}
                  {/* Three calls to one file is a different story from one, and it is the shape
                      of an agent going back and forth over the same thing. */}
                  {file.edits > 1 ? (
                    <span className="shrink-0">×{file.edits}</span>
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

          <ReasoningList reasoning={result.reasoning} />

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

/**
 * The run, while it is still running.
 *
 * Open, not under a disclosure, and that is the whole difference from the finished digest: a
 * viewer looking at this is looking at it BECAUSE the answer is not here yet. A spinner for that
 * long reads as a hang; watching a second model reason its way through the turn reads as work.
 */
function RunInProgress({
  reasoning,
  thought,
  onDismiss,
}: {
  reasoning: string[];
  thought: string;
  onDismiss: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-muted-foreground" aria-live="polite">
          Reading the turn…
        </p>
        <DismissButton onDismiss={onDismiss} />
      </div>
      {reasoning.length > 0 || thought ? (
        <ol className="flex flex-col gap-1 border-l border-border pl-2.5">
          {reasoning.map((text, index) => <Thought key={index} text={text} />)}
          {/* The block still arriving. Replaced by its finished form rather than kept beside it,
              so one thought never appears twice. */}
          {thought ? <Thought text={thought} /> : null}
        </ol>
      ) : null}
    </div>
  );
}

/**
 * What the summarizer reasoned, under a disclosure.
 *
 * Collapsed by default and deliberately below the digest: once the answer exists, the answer is
 * what someone reads, and this is the receipt for it. It is here at all because a digest is a
 * claim about someone else's work written by a model, and its reasoning is the only thing that
 * shows whether the claim was arrived at or guessed.
 */
function ReasoningList({ reasoning }: { reasoning: string[] }) {
  const [open, setOpen] = useState(false);
  if (reasoning.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((shown) => !shown)}
        aria-expanded={open}
        className="flex w-fit cursor-pointer items-center gap-1 rounded text-xs text-muted-foreground transition-colors hover:text-foreground active:text-foreground/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {open
          ? <ChevronDown className="size-3.5 shrink-0" aria-hidden />
          : <ChevronRight className="size-3.5 shrink-0" aria-hidden />}
        how it read the turn
      </button>

      {open ? (
        <ol className="flex flex-col gap-1 border-l border-border pl-2.5">
          {reasoning.map((text, index) => <Thought key={index} text={text} />)}
        </ol>
      ) : null}
    </div>
  );
}

/** One reasoning block, rendered the same whether the run is going or long finished. */
function Thought({ text }: { text: string }) {
  return (
    <li className="whitespace-pre-wrap text-xs text-muted-foreground italic">{text}</li>
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
