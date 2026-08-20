"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { SummaryResult, SummaryStep } from "@agentdesk/agent-feed-wire";
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
    ? state.steps.length + state.thought.length
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
        <RunInProgress steps={state.steps} thought={state.thought} onDismiss={onDismiss} />
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

          <StepList steps={result.steps} />

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
 * viewer looking at this is looking at it BECAUSE the answer is not here yet. Half a minute of
 * spinner reads as a hang; half a minute of watching a second agent open the files it is about
 * to describe reads as work.
 */
function RunInProgress({
  steps,
  thought,
  onDismiss,
}: {
  steps: SummaryStep[];
  thought: string;
  onDismiss: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-muted-foreground" aria-live="polite">
          Reading the turn and the working tree…
        </p>
        <DismissButton onDismiss={onDismiss} />
      </div>
      {steps.length > 0 || thought ? (
        <ol className="flex flex-col gap-1 border-l border-border pl-2.5">
          {steps.map((step, index) => <StepRow key={index} step={step} />)}
          {/* The reasoning block still arriving. Replaced by its finished `step` rather than
              kept beside it, so one thought never appears twice. */}
          {thought ? (
            <li className="whitespace-pre-wrap text-xs text-muted-foreground italic">{thought}</li>
          ) : null}
        </ol>
      ) : null}
    </div>
  );
}

/**
 * What the summarizer read and thought, under a disclosure.
 *
 * Collapsed by default and deliberately below the digest: once the answer exists, the answer is
 * what someone reads, and this is the receipt for it. It is here at all because a digest is a
 * claim about someone else's work written by a model -- "it opened these three files" is what
 * makes the claim checkable, and a summarizer that read nothing is worth catching.
 */
function StepList({ steps }: { steps: SummaryStep[] }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;

  const tools = steps.filter((step) => step.kind === "tool").length;
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
        how it read the turn · {tools} {tools === 1 ? "lookup" : "lookups"}
      </button>

      {open ? (
        <ol className="flex flex-col gap-1 border-l border-border pl-2.5">
          {steps.map((step, index) => <StepRow key={index} step={step} />)}
        </ol>
      ) : null}
    </div>
  );
}

/** One step, rendered the same whether the run is still going or long finished. */
function StepRow({ step }: { step: SummaryStep }) {
  if (step.kind === "thinking") {
    return (
      <li className="whitespace-pre-wrap text-xs text-muted-foreground italic">{step.text}</li>
    );
  }
  return (
    <li
      className={`flex gap-2 font-mono text-xs ${
        step.failed ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      <span className="shrink-0 text-foreground">{step.name}</span>
      <span className="min-w-0 break-all">{step.target}</span>
      {/* Said, not styled away: a lookup that failed explains a digest that guessed, which is
          the reason to keep reading. */}
      {step.failed ? <span className="shrink-0">failed</span> : null}
    </li>
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
