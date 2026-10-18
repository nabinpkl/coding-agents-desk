"use client";

import { useRef, useState } from "react";
import { X } from "lucide-react";
import type { UsageVendorId, VendorUsage } from "@agentdesk/agent-feed-wire";
import { VendorPanel } from "@/features/usage/UsageVendorPanel";
import { weekBounds } from "@/features/usage/usageGrid";
import type { UsageState } from "@/features/usage/useUsage";
import { useModal } from "@/hooks/dom/overlays";

const RANGES = [
  { label: "12w", weeks: 12 },
  { label: "26w", weeks: 26 },
  { label: "all", weeks: 0 },
] as const;

const DEFAULT_WEEKS = 26;

export function UsageModal({
  open,
  state,
  onClose,
  now = Date.now,
}: {
  open: boolean;
  state: UsageState;
  onClose: () => void;
  now?: () => number;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useModal(dialog, open);

  return (
    <dialog
      ref={dialog}
      aria-label="Token usage"
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        // The backdrop is the dialog element itself; a click that lands on it rather than on the
        // panel inside is a click outside.
        if (event.target === dialog.current) onClose();
      }}
      className="m-auto max-h-[88dvh] w-[min(46rem,92vw)] overflow-hidden rounded-xl border border-border
        bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/40"
    >
      {open ? <UsageModalBody state={state} onClose={onClose} now={now} /> : null}
    </dialog>
  );
}

function UsageModalBody({
  state,
  onClose,
  now,
}: {
  state: UsageState;
  onClose: () => void;
  now: () => number;
}) {
  const [weeks, setWeeks] = useState(DEFAULT_WEEKS);
  const [activeDate, setActiveDate] = useState<string | null>(null);
  // Which vendor's grid is showing. React state and nothing more: choosing a tab is one click,
  // the modal is not open across a reload for a stored value to come back to, and the panel's
  // rule for storage is a fact whose absence would cost the reader real work to re-establish.
  const [chosenVendor, setChosenVendor] = useState<UsageVendorId | null>(null);
  const vendors = state.kind === "ready" ? state.report.vendors : [];
  // Falls back to the first INSTALLED vendor rather than the first listed, so a machine with only
  // one of the two opens on the tab that has something to show.
  const vendor = vendors.find((entry) => entry.vendor === chosenVendor)
    ?? vendors.find((entry) => entry.installed)
    ?? vendors[0]
    ?? null;
  // The first sweep on a cold cache reads gigabytes and takes seconds. The panel is drawn at its
  // final size throughout and withholds the figures rather than the layout, so nothing moves when
  // the report finally lands.
  const loading = state.kind === "loading" || state.kind === "idle";

  return (
    <div className="flex max-h-[88dvh] flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Usage</h2>
        {loading || vendor?.installed ? (
          <div role="group" aria-label="Range" className="flex items-center gap-0.5">
            {RANGES.map((range) => {
              const value = range.weeks === 0 ? allWeeks(vendor, now) : range.weeks;
              const selected = weeks === value;
              return (
                <button
                  key={range.label}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setWeeks(value)}
                  className={"rounded-md px-2 py-1 text-xs transition-colors "
                    + "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary "
                    + (selected
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80")}
                >
                  {range.label}
                </button>
              );
            })}
          </div>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close usage"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground
            transition-colors hover:bg-muted hover:text-foreground active:bg-muted/80
            focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <VendorTabs
        vendors={vendors}
        selected={vendor?.vendor ?? null}
        onSelect={(next) => {
          setChosenVendor(next);
          // The hovered day belongs to the grid that was showing. Carrying it across would point
          // the readout at a date the new vendor may have no record of, which renders as the
          // fallback day and reads as the tab having ignored the click.
          setActiveDate(null);
        }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {state.kind === "error" ? (
          <p className="py-6 text-center text-sm text-destructive">Usage unavailable: {state.message}</p>
        ) : vendor && !vendor.installed ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No {vendor.displayName} records on this machine.
          </p>
        ) : vendor && vendor.days.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {vendor.displayName} has recorded no usage yet.
          </p>
        ) : (
          <VendorPanel
            vendor={vendor}
            loading={loading}
            weeks={weeks}
            activeDate={activeDate}
            onActivate={setActiveDate}
            now={now}
          />
        )}
      </div>
    </div>
  );
}

/**
 * One tab per vendor, on their own row rather than beside the title.
 *
 * Beside the title they competed with the range group and the close button for a header that is
 * 359px wide on a phone, and the first thing to truncate would have been the vendor names -- the
 * one control on the row whose whole job is to say which numbers are on screen.
 *
 * Every vendor gets a tab, installed or not. A machine with no Codex records shows a Codex tab
 * that says so, which is a different and more useful answer than a tab bar that silently omits it
 * and leaves a reader wondering whether the panel can read Codex at all.
 *
 * The row is rendered at its full height while the report is still loading, holding an empty
 * tablist, for the same reason every other height in this modal is fixed: the grid below must not
 * move when the numbers land.
 */
function VendorTabs({
  vendors,
  selected,
  onSelect,
}: {
  vendors: VendorUsage[];
  selected: UsageVendorId | null;
  onSelect: (vendor: UsageVendorId) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Vendor"
      className="flex h-9 shrink-0 items-stretch gap-1 border-b border-border px-3"
    >
      {vendors.map((vendor) => {
        const active = vendor.vendor === selected;
        return (
          <button
            key={vendor.vendor}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(vendor.vendor)}
            className={"-mb-px border-b-2 px-2 text-xs transition-colors "
              + "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary "
              + (active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground active:text-foreground/80")}
          >
            {vendor.displayName}
            {/* Said on the tab, not only inside it, so a reader can see which vendor has records
                without opening each one. */}
            {vendor.installed ? null : (
              <span className="ml-1 text-muted-foreground/70">not found</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Whole weeks from the first recorded day to today, so "all" means all of it. */
function allWeeks(vendor: VendorUsage | null, now: () => number): number {
  if (!vendor?.coverage.from) return DEFAULT_WEEKS;
  const first = weekBounds(vendor.coverage.from).start;
  const elapsed = new Date(now()).getTime() - new Date(`${first}T00:00:00`).getTime();
  return Math.max(1, Math.ceil(elapsed / (7 * 24 * 60 * 60 * 1000)));
}
