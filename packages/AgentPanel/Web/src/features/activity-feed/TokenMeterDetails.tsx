"use client";

// What the context readout says when a reader asks it for more: the figures the compact meter
// rounds away, and this machine's rate-limit meters beside them.
//
// The two belong on one surface because they answer one question asked twice. "How much room is
// left" is the context window on this turn AND the five-hour window across every session running
// on this machine, and the second one is invisible everywhere else in the panel -- it is not in
// the transcript, and the CLI only shows it in its own status line.

import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FoldVertical, LoaderCircle } from "lucide-react";
import type { UsageQuota } from "@agentdesk/agent-feed-wire";
import type { TokenUsage } from "@/features/activity-feed/useSessionEventsStream";
import type { CompactControl, HoverHandlers } from "@/features/activity-feed/TokenMeter";
import type { LimitsState } from "@/features/usage/useLimits";
import { formatAge, formatResetIn, formatUsd, STALE_QUOTA_MS } from "@/features/usage/formatTokens";
import { useDismissOnOutsidePress, useOverlayPlacement } from "@/hooks/dom/overlays";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useNotify } from "@/hooks/useNotify";

/** The gap this panel keeps between itself and the edge of the window. */
const MARGIN = 8;
/** The gap between the readout and the panel. */
const GAP = 6;

/** Where an open panel sits, in viewport coordinates, because it is positioned `fixed`. */
interface Placement {
  top: number;
  left: number;
}

/**
 * Above the readout by default, since the readout sits at the bottom of a card, and clamped on
 * both axes so a card at any edge still gets a panel that is entirely on screen.
 *
 * Measured against the WINDOW rather than against anything it is in, and rendered into
 * `document.body` for the reason `RowMenu` documents at length: every canvas card sets
 * `overflow-hidden` to keep its content inside its rounded corners, so a panel drawn as a child
 * of the composer is cut off at the card's edge no matter what its z-index says.
 */
function place(trigger: DOMRect, panel: DOMRect): Placement {
  const viewportHeight = globalThis.innerHeight || 0;
  const viewportWidth = globalThis.innerWidth || 0;
  const above = trigger.top - MARGIN;
  const below = viewportHeight - trigger.bottom - MARGIN;
  const top = panel.height > above && below > above
    ? trigger.bottom + GAP
    : trigger.top - GAP - panel.height;
  return {
    top: Math.max(MARGIN, Math.min(top, viewportHeight - MARGIN - panel.height)),
    left: Math.max(MARGIN, Math.min(trigger.right - panel.width, viewportWidth - MARGIN - panel.width)),
  };
}

export function TokenMeterDetails({
  usage,
  limits,
  costlyNote,
  compact,
  // Named for what it is: React Compiler reads a `.current` off a name ending in `Ref` as a ref.
  trigger: triggerRef,
  focusOnOpen,
  hover,
  onDismiss,
  now = Date.now,
}: {
  usage: TokenUsage;
  limits: LimitsState;
  /** Why the count is amber below the warning fractions, or null when it is not. */
  costlyNote: string | null;
  compact: CompactControl | null;
  trigger: React.RefObject<HTMLElement | null>;
  /** True when a key opened it: focus moves in, since the panel sits at the end of the page. */
  focusOnOpen: boolean;
  hover: HoverHandlers;
  onDismiss: () => void;
  now?: () => number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  /** Null until the layout pass has measured; the panel stays invisible until then. */
  const [placement, setPlacement] = useState<Placement | null>(null);

  const reposition = useCallback(() => {
    const anchor = triggerRef.current;
    const popup = panel.current;
    if (!anchor || !popup) return;
    setPlacement(place(anchor.getBoundingClientRect(), popup.getBoundingClientRect()));
  }, [triggerRef]);

  // Before paint, so the panel is placed in the same commit that opens it rather than appearing
  // in the corner of the window for a frame.
  // Every scroller, not just the page: without it the panel stays where the readout USED to be
  // as soon as the canvas moves.
  useOverlayPlacement(true, () => reposition(), [reposition]);

  // Portalled to the end of the body, so Tab from the trigger would never reach it.
  useDomSync(() => {
    if (!focusOnOpen) return;
    const popup = panel.current;
    (popup?.querySelector<HTMLElement>("button:not(:disabled)") ?? popup)?.focus();
  }, [focusOnOpen]);

  useDismissOnOutsidePress(true, [panel, triggerRef], onDismiss);

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Context and limits"
      // For anything that asks "is the pointer still inside me" with a DOM containment test: the
      // React tree still has this panel inside the composer, so React's own enter/leave pairing
      // is unaffected by the portal, but a raw `node.contains` is not.
      data-portal-menu=""
      tabIndex={-1}
      {...hover}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onDismiss();
        triggerRef.current?.focus();
      }}
      style={{
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        visibility: placement ? undefined : "hidden",
      }}
      className="fixed z-50 w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none"
    >
      <ContextFigures usage={usage} now={now} />
      {costlyNote ? <p className="mt-1.5 text-xs text-amber-500">{costlyNote}</p> : null}
      {compact ? <CompactButton control={compact} onSent={onDismiss} /> : null}
      <div className="mt-3 border-t border-border pt-2">
        <Limits state={limits} now={now} />
      </div>
    </div>,
    document.body,
  );
}

function ContextFigures({ usage, now }: { usage: TokenUsage; now: () => number }) {
  const percent = usage.limit === null
    ? null
    : Math.round(Math.min(1, Math.max(0, usage.current / usage.limit)) * 100);
  return (
    <dl className="flex flex-col gap-1 text-xs">
      <Figure label="Context">
        {usage.current.toLocaleString()}
        {usage.limit === null ? "" : ` / ${usage.limit.toLocaleString()}`}
        {percent === null ? "" : ` (${percent}%)`}
      </Figure>
      {usage.model ? <Figure label="Model">{usage.model}</Figure> : null}
      <Figure label="Prompt cache">{cacheText(usage, now())}</Figure>
      {usage.cost !== undefined && usage.cost > 0
        ? <Figure label="Session cost">{formatUsd(usage.cost)}</Figure>
        : null}
    </dl>
  );
}

/**
 * `/compact`, sent from the composer, beside the figures that say whether it is worth doing.
 *
 * Closes the panel once it went: the transcript is where the compaction shows. A refusal keeps the
 * panel open and says so, because a button that does nothing visible reads as one that worked.
 */
function CompactButton({ control, onSent }: { control: CompactControl; onSent: () => void }) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const note = control.blocked ?? failure;
  const { prepare } = control;
  // Whatever the control needs ready before it can be pressed, asked for as it is shown.
  useNotify(prepare, (ready) => ready?.());
  return (
    <div className="mt-2.5 flex flex-col items-end gap-1">
      <button
        type="button"
        aria-label="Compact this session's context"
        disabled={control.blocked !== null || sending}
        onClick={async () => {
          setSending(true);
          setFailure(null);
          let sent = false;
          try {
            sent = await control.run();
            if (!sent) setFailure("/compact did not go through. The composer says why.");
          } catch (error) {
            setFailure(`/compact did not go through: ${String((error as Error).message ?? error)}`);
          }
          if (sent) {
            onSent();
            return;
          }
          setSending(false);
        }}
        className="inline-flex h-7 cursor-pointer touch-manipulation items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-primary active:bg-foreground/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {sending
          ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          : <FoldVertical className="size-3.5" aria-hidden />}
        Compact
      </button>
      {note ? (
        <p className={"text-right text-xs " + (failure && !control.blocked ? "text-destructive" : "text-muted-foreground")}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * When re-reading this context stops being cheap.
 *
 * It is a 20x step and nothing else on the surface shows it: a cached context re-reads at 0.1x
 * base input and an expired one rewrites at 2.0x, paid in full on the next message.
 */
function cacheText(usage: TokenUsage, at: number): string {
  if (!usage.cacheTtlMs) return "not reported";
  const remaining = usage.updatedAt + usage.cacheTtlMs - at;
  if (remaining <= 0) return "expired, the next message rewrites it";
  return `warm for ${Math.ceil(remaining / 60_000)} min`;
}

function Limits({ state, now }: { state: LimitsState; now: () => number }) {
  if (state.kind === "error") {
    return <p className="text-xs text-destructive">Limits unavailable: {state.message}</p>;
  }
  if (state.kind !== "ready") {
    return <p className="text-xs text-muted-foreground">Reading limits...</p>;
  }
  if (state.quotas.length === 0 && state.unavailable !== undefined) {
    return <p className="text-xs text-muted-foreground">Plan usage unavailable ({state.unavailable}).</p>;
  }
  if (state.quotas.length === 0) {
    // The one thing a reader genuinely cannot work out from the surface: the meters are missing
    // because none has been observed yet, not because they are at zero.
    return (
      <p className="text-xs text-muted-foreground">
        No limit reading yet. These arrive on the account's next API response.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {state.quotas.map((quota) => (
        <LimitRow key={`${quota.label}:${quota.windowMinutes}`} quota={quota} now={now} />
      ))}
    </div>
  );
}

function LimitRow({ quota, now }: { quota: UsageQuota; now: () => number }) {
  const at = now();
  const stale = at - quota.sampledAt > STALE_QUOTA_MS;
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-foreground">{quota.label}</span>
        <span className="shrink-0 font-mono tabular-nums text-foreground">{quota.usedPercent}%</span>
      </div>
      <span className="h-1.5 overflow-hidden rounded-full bg-muted">
        <span
          role="progressbar"
          aria-label={`${quota.label}: ${quota.usedPercent}% used`}
          aria-valuenow={quota.usedPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          className={"block h-full rounded-full "
            + (quota.usedPercent >= 90
              ? "bg-destructive"
              : quota.usedPercent >= 75
                ? "bg-amber-500"
                : "bg-foreground/60")}
          style={{ width: `${Math.min(100, Math.max(0, quota.usedPercent))}%` }}
        />
      </span>
      {/* A stale reading cannot answer "when does this clear" -- its reset has usually already
          passed -- so it answers "how old is this" instead, which is the only true thing left to
          say about it. */}
      <span className="text-muted-foreground">
        {stale
          ? `reading ${formatAge(quota.sampledAt, at)}`
          : `resets in ${formatResetIn(quota.resetsAt, at)}`}
      </span>
    </div>
  );
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-mono tabular-nums text-foreground">{children}</dd>
    </div>
  );
}
