import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QuotaVendorId, UsageQuota } from "@agentdesk/agent-feed-wire";
import type { TokenUsage } from "@/features/activity-feed/useSessionEventsStream";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { TokenMeterDetails } from "@/features/activity-feed/TokenMeterDetails";
import { useLimits, type LimitsState } from "@/features/usage/useLimits";
import { formatUsd, formatWindow, STALE_QUOTA_MS } from "@/features/usage/formatTokens";

/**
 * The panel's Compact button, as the composer hands it over.
 *
 * Built by the composer rather than here, because which door `/compact` goes through -- the pane,
 * the CLI inbox, a pty, opencode's command route -- is the composer's question, and this meter
 * only knows the context it is about.
 */
export interface CompactControl {
  /** Sends `/compact`. Resolves true once it went, false when the composer refused it. */
  run: () => Promise<boolean>;
  /** Why it cannot be sent right now, or null when it can. */
  blocked: string | null;
  /** Called when the button is shown, to reach whatever the send needs before it can go. */
  prepare?: () => void;
}

/** Hover handlers the trigger and the panel share, so either one keeps the panel open. */
export interface HoverHandlers {
  onPointerEnter: (event: React.PointerEvent) => void;
  onPointerLeave: (event: React.PointerEvent) => void;
}

/**
 * How long the panel stays after the pointer leaves the trigger or the panel. Long enough to cross
 * the gap between them, short enough that pointing past the meter does not leave it standing.
 */
const HOVER_CLOSE_MS = 150;

/**
 * Open while a mouse is over the trigger or the panel, with a short grace on leaving.
 *
 * Touch is ignored: a tap fires enter and leave around itself, and on a phone the tap's own click
 * is what opens the panel. Taking the enter as well would open it and let the click shut it again.
 */
function useHoverOpen() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  const close = useCallback(() => {
    cancel();
    setOpen(false);
  }, [cancel]);
  const handlers = useMemo<HoverHandlers>(() => ({
    onPointerEnter: (event) => {
      if (event.pointerType === "touch") return;
      cancel();
      setOpen(true);
    },
    onPointerLeave: (event) => {
      if (event.pointerType === "touch") return;
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        setOpen(false);
      }, HOVER_CLOSE_MS);
    },
  }), [cancel]);
  return useMemo(() => ({ open, close, handlers }), [open, close, handlers]);
}

/** Fill fraction above which the meter reads as a warning rather than a fact. */
const WARN_FRACTION = 0.75;
/** Fill fraction above which compaction is imminent enough to say so loudly. */
const CRITICAL_FRACTION = 0.9;
/**
 * Occupancy above which compacting has paid for itself inside one more user turn.
 *
 * A second reason to warn, because the fractions above answer a different question. They are about
 * running OUT -- the window ending, and compaction happening whether or not anyone chose it -- and
 * on a 1M window that leaves the meter grey from 150k to 750k, which is the entire range where
 * compacting is the cheaper move. The two share a colour because they share an action.
 *
 * Measured on this project's own transcripts, in base-input-token units at $5.00/MTok (cache read
 * 0.1x, 1h cache write 2.0x, output 5.0x):
 *
 * - Compacting costs about 144,800 units, roughly $0.72, and that figure is FLAT in context size.
 *   The summariser reads the whole context too, so its `0.1 x C` term cancels against continuing;
 *   what is left is the summary's output and the next turn's rewrite of a fresh prefix.
 * - Every later request then saves `0.1 x (C - 83k)`, 83k being the measured size a compacted
 *   context comes back at. The gap never closes: both branches grow at the same rate.
 * - So break-even is `debt / saving` requests, and this session runs 11.7 API requests per user
 *   turn. At 200k that is 12.4 requests, which is one turn. At 500k it is under four.
 *
 * A model with a 200k window can never reach this, and does not need to: its fractions fire first.
 */
const COMPACTION_PAYS_ABOVE = 200_000;
/**
 * What the amber means once the count has passed that line, in the panel beside the Compact button
 * and on the count's accessible name.
 *
 * Both, rather than the panel alone: colour is the only other thing carrying this, and a reader
 * who cannot see the colour would otherwise have no way to the state at all.
 */
const COSTLY_NOTE = "Compacting now pays for itself within a turn";
/** Minutes of cache left below which the countdown stops being a fact and starts
 *  being a warning. Ten because the thing it is warning about takes a minute or
 *  two to act on: compacting while warm is what makes the next message cheap. */
const CACHE_WARN_MINUTES = 10;
/** How often the countdown re-reads the clock. It renders whole minutes, so this
 *  only bounds how stale the displayed minute can be, and every session header on
 *  screen pays it. */
const CACHE_TICK_MS = 15_000;

/** Whole minutes until the prompt cache behind this context expires, or null when
 *  the sidecar published no lifetime for it. Floors at zero and stays there: an
 *  expired cache does not get more expired, and the next request is what moves it. */
function minutesOfCacheLeft(usage: TokenUsage, now: number): number | null {
  if (!usage.cacheTtlMs) return null;
  const remaining = usage.updatedAt + usage.cacheTtlMs - now;
  return remaining <= 0 ? 0 : Math.ceil(remaining / 60_000);
}

/**
 * Minutes of prompt cache left, beside the occupancy count.
 *
 * It is here because the step it counts down to is a 20x one and nothing else on
 * the surface shows it: a context that is still cached re-reads at 0.1x base
 * input, and one that has expired rewrites at 2.0x, paid in full on the next
 * message. A 500k session that sleeps through its hour pays about ten times what
 * the same message costs while warm, and the transcript looks identical either
 * way.
 */
function CacheCountdown({ usage }: { usage: TokenUsage }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CACHE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const minutes = minutesOfCacheLeft(usage, now);
  if (minutes === null) return null;
  const tone =
    minutes === 0
      ? "text-destructive"
      : minutes <= CACHE_WARN_MINUTES
        ? "text-amber-500"
        : "text-muted-foreground/70";
  return (
    <span
      aria-label={`Prompt cache: ${minutes} minutes left`}
      className={
        "font-mono text-(length:--agent-panel-fs-tile-chip,12px) leading-none tabular-nums " +
        tone
      }
    >
      {minutes}m
    </span>
  );
}

/**
 * The family word out of a model id: `claude-opus-5[1m]` -> `opus`.
 *
 * Read off the id rather than looked up, which is why there is no table of model names here to go
 * stale the day a fifth family ships. The sidecar's `claudeModelAlias` stays the authority
 * anywhere the version matters -- the usage calendar names three different `opus` ids in a list
 * whose whole job is telling them apart, and this footer has room for one word.
 *
 * Null for an id that is not shaped like one of Claude's: `<synthetic>`, and Codex, which names no
 * model on an occupancy record at all. Nothing is guessed from those, because the exact id is
 * already one hover away on the count beside this.
 */
export function modelFamily(model: string | undefined): string | null {
  const match = /^claude-([a-z]+)(?:-|\[|$)/.exec((model ?? "").trim());
  return match ? match[1]! : null;
}

/**
 * Which model this context is being spent on, in the one word the row has room for.
 *
 * The version is dropped on purpose: what a reader checks here is whether they are still on the
 * model they meant to be on, and `opus` answers that where `claude-opus-5[1m]` would take the
 * width the occupancy count needs. The full id is on the title, on the count's tooltip, and named
 * outright in the popover.
 */
function ModelChip({ model }: { model: string | undefined }) {
  const family = modelFamily(model);
  if (family === null) return null;
  return (
    <span
      aria-label={`Model: ${model}`}
      className="font-mono text-(length:--agent-panel-fs-tile-chip,12px) leading-none text-muted-foreground/70"
    >
      {family}
    </span>
  );
}

/**
 * The session's lifetime spend, beside the count the way the TUI sets it: `tokens (percent)
 * · $cost`. Carried on the usage rather than looked up, because it arrives on the same
 * reading from the sidecar. Rendered only where a backend reported one, which today is
 * opencode sessions alone -- Claude and Codex name no dollar figure on theirs.
 */
function CostChip({ cost }: { cost: number | undefined }) {
  if (cost === undefined || !(cost > 0)) return null;
  const text = formatUsd(cost);
  return (
    <span
      aria-label={`Session cost ${text}`}
      className="font-mono text-(length:--agent-panel-fs-tile-chip,12px) leading-none tabular-nums text-muted-foreground"
    >
      {text}
    </span>
  );
}

/**
 * Occupancy as a compact count, with a fill bar when the window is known, and the figures behind
 * both on hover or a click.
 *
 * This is why `token_count` records no longer take a transcript row of their own:
 * they are 19% of the rows in this project's largest Codex session, and every one
 * supersedes the last, so the whole series collapses to this one live readout.
 *
 * `limit` arrives already resolved from the sidecar, so nothing here maps a model
 * name to a window. When it is null the bar is omitted rather than guessed --
 * a fraction of an invented denominator reads as authoritative and is not.
 */
export function TokenMeter({
  usage,
  feed = null,
  vendor = null,
  compact = null,
  showModel = true,
}: {
  usage: TokenUsage | null;
  /**
   * The sidecar to read this machine's rate limits from, or null where there is none to ask.
   */
  feed?: Pick<SidecarDataSource, "subscribeLimits"> | null;
  /**
   * Which vendor's windows to show, or null to show every vendor's.
   *
   * Both vendors meter five hours, so a Claude card that also drew Codex's would put two chips
   * reading `5h` at different numbers side by side -- and either could be read as the one about
   * to stop you.
   */
  vendor?: QuotaVendorId | null;
  /** The panel's Compact button, or null where this session's composer cannot run one. */
  compact?: CompactControl | null;
  /**
   * Whether the row leads with the model. False where the composer's own model selector already
   * names it, so the footer does not say it twice; the details panel names it either way.
   */
  showModel?: boolean;
}) {
  // Hooks before the early return, because a session whose occupancy has not arrived yet renders
  // nothing and then renders something, and a conditional hook would break on exactly that.
  const trigger = useRef<HTMLButtonElement>(null);
  // Two ways in, one state. Hover is the cheap look on a mouse, and a click or a tap pins the
  // panel so it stays until dismissed. A tap is the only way in on a phone, which has no hover.
  const [pinned, setPinned] = useState(false);
  const hover = useHoverOpen();
  /** Set when a key opened the panel, so focus goes into it rather than staying behind. */
  const [keyboardOpened, setKeyboardOpened] = useState(false);
  const limits = useLimits(feed, vendor);
  const open = hover.open || pinned;
  const dismiss = useCallback(() => {
    setPinned(false);
    hover.close();
  }, [hover]);

  if (!usage) return null;

  const count = formatTokens(usage.current);
  // Nothing here divides by the window, which is why the cost warning survives a session with no
  // window at all: what compacting saves is a property of the context's SIZE, not of how much room
  // is left beside it.
  const costly = usage.current >= COMPACTION_PAYS_ABOVE;
  const fraction = usage.limit === null
    ? null
    : Math.min(1, Math.max(0, usage.current / usage.limit));
  const percent = fraction === null ? null : Math.round(fraction * 100);
  const tone =
    fraction !== null && fraction >= CRITICAL_FRACTION
      ? "text-destructive"
      : (fraction !== null && fraction >= WARN_FRACTION) || costly
        ? "text-amber-500"
        : "text-muted-foreground";
  // Deliberately not `costly`, unlike the count above it. The track is how FULL the window is, and
  // an amber track on a bar drawn at 30% says the window is nearly gone, which is not what the
  // cost line means. The count is the size, and the size is what compacting is about.
  const fill =
    fraction !== null && fraction >= CRITICAL_FRACTION
      ? "bg-destructive"
      : fraction !== null && fraction >= WARN_FRACTION
        ? "bg-amber-500"
        : "bg-muted-foreground/60";

  return (
    // Two readings, not three. The cache clock answers "how long is this context still cheap to
    // re-read"; the count and the track answer "how big is it", and they are one object drawn as
    // one -- same width, same edges, stacked, with only their own hairline gap between them. The
    // gap out to the clock is four times that, which is what keeps the bar from reading as the
    // clock's. The model leads and is not a reading at all: it is what every number after it is
    // about, and it changes hourly on a session whose reader switches model mid-thread.
    <>
      {/* One button for the whole row: every chip on it is a short form of something the panel says
          in full, so pointing at any of them is asking for the panel. None carries a native tooltip,
          which would draw over the panel it opens. */}
      <button
        ref={trigger}
        type="button"
        aria-label="Context and limits"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          // A second click closes it outright, even with the mouse still over it: unpinning alone
          // would leave hover holding it open, and the click would look like it did nothing.
          if (pinned) {
            dismiss();
            return;
          }
          setKeyboardOpened(event.detail === 0);
          setPinned(true);
        }}
        {...hover.handlers}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          event.preventDefault();
          dismiss();
        }}
        className="flex min-h-7 shrink-0 cursor-pointer touch-manipulation items-center gap-2 rounded-sm px-1 outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-primary active:bg-foreground/10"
      >
        {showModel ? <ModelChip model={usage.model} /> : null}
        <CacheCountdown usage={usage} />
        <LimitChips quotas={accountWide(limits)} unavailable={limits.kind === "ready" ? limits.unavailable : undefined} />
        <span className="flex flex-col items-end gap-[2px]">
          <span
            className={
              "min-w-8 text-right font-mono text-(length:--agent-panel-fs-tile-chip,12px) leading-none tabular-nums " +
              tone
            }
            {...(usage.limit === null
              ? { "aria-label": `Context: ${usage.current.toLocaleString()} tokens${costly ? ` · ${COSTLY_NOTE}` : ""}` }
              : {})}
          >
            {count}{percent === null ? "" : ` (${percent}%)`}
          </span>
          {/* The track carries the role and the accessible name, not the wrapper: the bar IS the
              fraction, and naming it here is what makes the readout addressable rather than a
              decorative div. Its width is the count's, fixed, so the two share an edge on both
              sides and the header does not reflow every time the count crosses a digit boundary --
              which on a live thread is every few seconds. */}
          {percent === null ? null : (
            <span
              role="progressbar"
              aria-label={`Context: ${percent}% of ${usage.limit!.toLocaleString()} tokens${costly ? ` · ${COSTLY_NOTE}` : ""}`}
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-[3px] w-full overflow-hidden rounded-full bg-muted"
            >
              <span
                className={"block h-full rounded-full " + fill}
                style={{ width: `${percent}%` }}
              />
            </span>
          )}
        </span>
        <CostChip cost={usage.cost} />
      </button>
      {/* Beside the button rather than in it: the panel is portalled out of the DOM, but React
          still bubbles its clicks through the tree, and a press on Compact would toggle the pin. */}
      {open ? (
        <TokenMeterDetails
          usage={usage}
          limits={limits}
          costlyNote={costly ? COSTLY_NOTE : null}
          compact={compact}
          trigger={trigger}
          focusOnOpen={keyboardOpened}
          hover={hover.handlers}
          onDismiss={dismiss}
        />
      ) : null}
    </>
  );
}

/**
 * The windows that meter EVERYTHING, which is what the composer has room to show.
 *
 * Claude publishes `seven_day_opus` and `seven_day_sonnet` beside its account-wide `seven_day`,
 * and all three would render as `7d` here. The scoped ones are the popover's job, where there is a
 * line each to name which model they cover.
 */
function accountWide(limits: LimitsState): UsageQuota[] {
  if (limits.kind !== "ready") return [];
  // Absent counts as unscoped, not as "not account-wide". A strict `=== null` reads `undefined`
  // as a scope and hides EVERY chip, which is what a sidecar that has not yet restarted onto the
  // new field sends -- measured against the running one, which answers with no `scope` at all.
  // The feature would then look broken rather than degraded, and silently: the surface has no way
  // to say "I am hiding these because a field I wanted was missing".
  return limits.quotas.filter((quota) => !quota.scope);
}

/**
 * The account's limits as the CLI's status line says them: `5h: 25%  7d: 51%`.
 *
 * Beside the context count rather than inside the popover, because the two answer the same
 * question at different scales and only one of them was ever visible. The context count is this
 * turn; these are every session on this machine, and a reader who is about to start something long
 * needs the one that is going to stop them without having to go looking for it.
 *
 * Nothing at all until a reading arrives: a chip reading `5h: 0%` before the first API response
 * would be a confident wrong answer, where an absent chip is merely quiet.
 */
function LimitChips({ quotas, unavailable }: { quotas: UsageQuota[]; unavailable?: string }) {
  // A meter that exists but could not be read says so; it is never drawn as 0%.
  if (quotas.length === 0 && unavailable !== undefined) {
    return (
      <span
        title={`Plan usage unavailable: ${unavailable}`}
        className="shrink-0 font-mono text-(length:--agent-panel-fs-tile-chip,12px) leading-none text-muted-foreground/50"
      >
        usage n/a
      </span>
    );
  }
  if (quotas.length === 0) return null;
  const at = Date.now();
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {quotas.map((quota) => {
        // A reading whose own age has outrun its window cannot say when it resets -- that moment
        // has usually passed -- so the chip goes quiet and the panel says how old it is.
        const stale = at - quota.sampledAt > STALE_QUOTA_MS;
        return (
          <span
            key={`${quota.windowMinutes}:${quota.label}`}
            className={
              // The space is tightened because a monospace one is not a typographic space, it is
              // a character cell: 0.6em, which is 7.2px at the chip's 12px, against the 6px
              // between one chip and the next. The window and its percentage were further apart
              // than `5h: 1%` and `7d: 69%` were, so the row read as four loose things rather
              // than two pairs. In em, so it holds when the reader scales the panel's type.
              "font-mono text-(length:--agent-panel-fs-tile-chip,12px) leading-none tabular-nums "
              + "[word-spacing:-0.35em] "
              + chipTone(quota.usedPercent, stale)
            }
          >
            {formatWindow(quota.windowMinutes)}: {quota.usedPercent}%
          </span>
        );
      })}
    </span>
  );
}

/**
 * The same two thresholds the popover's bars use, so one window does not read as urgent in one
 * place and ordinary in the other.
 */
function chipTone(usedPercent: number, stale: boolean): string {
  if (stale) return "text-muted-foreground/50";
  if (usedPercent >= 90) return "text-destructive";
  if (usedPercent >= 75) return "text-amber-500";
  return "text-muted-foreground";
}

/**
 * Tokens as at most four glyphs: `812`, `41k`, `183k`, `1.2M`.
 *
 * The header has one line to spend beside a session title that is already
 * truncating, so `183,402` is not an option; the exact figure is in the tooltip
 * and the accessible label.
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
