"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronUp, CircleUser, Gauge, LayoutGrid } from "lucide-react";
import { DesktopParkModal } from "../desktop-park/DesktopParkModal";
import type { DesktopParkHandle } from "../desktop-park/useDesktopPark";
import { UsageModal } from "../usage/UsageModal";
import type { UsageHandle } from "../usage/useUsage";
import { formatResetIn } from "../usage/formatTokens";
import {
  canReceiveFragmentedVideo,
  detectMediaCapabilities,
  summarizeMediaCapabilities,
} from "./mediaCapabilities";

/**
 * The sidebar's bottom section, and the menu that opens up out of it.
 *
 * The menu is an absolutely positioned element INSIDE the row rather than a portal or the top
 * layer, and that is load-bearing rather than incidental: the hover preview sidebar dismisses
 * itself on `pointerleave` of its own `<aside>` (see `SidebarPresentation`), so a menu rendered
 * outside that subtree would vanish the moment the pointer moved into it. Rendered in place, the
 * pointer never leaves. It also opens upward by construction -- `bottom-full` -- with no
 * measurement, no anchor positioning, and nothing to clip it, because the row sits outside the
 * project tree's scroller.
 */
export function ProfileRow({ usage, park }: { usage: UsageHandle; park: DesktopParkHandle }) {
  const [open, setOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [parkOpen, setParkOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const available = usage.vendors.length > 0;

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Focus moves into the menu on open so the keyboard can reach it without tabbing past the
  // whole project tree.
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])")?.focus();
  }, [open]);

  const quota = quotaOf(usage);
  // Detected once per mount. These are engine facts, not session facts: they
  // cannot change while the page is alive, and re-probing on every menu open
  // would be pretending otherwise.
  const media = useMemo(() => detectMediaCapabilities(), []);

  return (
    <div className="relative shrink-0 border-t border-border pb-[env(safe-area-inset-bottom)]">
      {open ? (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Profile"
          className="absolute bottom-full left-2 right-2 z-50 mb-1 overflow-hidden rounded-lg border
            border-border bg-popover text-popover-foreground shadow-xl"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
              return;
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const items = Array.from(
              menu.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [],
            ).filter((item) => item.getAttribute("aria-disabled") !== "true");
            if (items.length === 0) return;
            const index = items.indexOf(document.activeElement as HTMLElement);
            const next = event.key === "ArrowDown" ? index + 1 : index - 1;
            items[(next + items.length) % items.length]?.focus();
          }}
        >
          <button
            type="button"
            role="menuitem"
            aria-disabled={!available}
            disabled={!available}
            onClick={() => {
              usage.load();
              setModalOpen(true);
              close(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors
              hover:bg-accent hover:text-accent-foreground active:bg-accent/80
              focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2
              focus-visible:outline-primary disabled:cursor-not-allowed disabled:text-muted-foreground
              disabled:hover:bg-transparent"
          >
            <Gauge className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Usage</span>
            {!available ? (
              <span className="shrink-0 text-xs text-muted-foreground">no records</span>
            ) : null}
          </button>
          {/* Gathering every window onto one Desktop is a machine-level action, not a
              thread-level one, so it belongs beside Usage rather than in the thread header.
              Disabled rather than hidden when yabai is absent: "this Mac cannot do it" is a
              more useful answer than an entry that was never there. */}
          <button
            type="button"
            role="menuitem"
            aria-disabled={!park.available}
            disabled={!park.available}
            onClick={() => {
              park.load();
              setParkOpen(true);
              close(false);
            }}
            className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm
              transition-colors hover:bg-accent hover:text-accent-foreground active:bg-accent/80
              focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2
              focus-visible:outline-primary disabled:cursor-not-allowed disabled:text-muted-foreground
              disabled:hover:bg-transparent"
          >
            <LayoutGrid className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Desktop park</span>
            {!park.available ? (
              <span className="shrink-0 text-xs text-muted-foreground">no yabai</span>
            ) : null}
          </button>
          {/* Identity, and not interactive. What makes this a profile menu rather than a button
              with a step in front of it. Both facts come from records the sidecar already parses;
              nothing here reads Codex's token store. */}
          <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            {/* Capitalized in CSS rather than in code: before the first report the only name
                available is the wire's vendor id, and the vendor's own display name belongs to
                the report, not to a second copy of the mapping kept here. */}
            <p className="truncate capitalize text-foreground">
              {available ? vendorNames(usage) : "No agent vendors detected"}
            </p>
            {quota ? (
              <p className="truncate">
                {quota.label} {quota.usedPercent}%, resets in {formatResetIn(quota.resetsAt, Date.now())}
              </p>
            ) : null}
            {/* What this webview can receive. Reported rather than assumed because
                the panel runs in two different WKWebViews and WebKit's release
                notes describe Safari. */}
            {/* Wraps rather than truncates: the whole point is that this line is
                readable in a screenshot taken on a phone, and a cut-off
                capability list answers nothing. */}
            <p
              className="font-mono text-[10px] leading-tight"
              title={
                canReceiveFragmentedVideo(media)
                  ? "This surface can play fragmented HEVC with the page only appending bytes."
                  : "This surface cannot play fragmented HEVC; video would need another path."
              }
            >
              <span className={canReceiveFragmentedVideo(media) ? "text-foreground" : "text-destructive"}>
                video {canReceiveFragmentedVideo(media) ? "ok" : "no"}
              </span>
              {" "}
              {summarizeMediaCapabilities(media)}
            </p>
          </div>
        </div>
      ) : null}

      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left transition-colors
          hover:bg-muted active:bg-muted/80 focus-visible:outline-2 focus-visible:-outline-offset-2
          focus-visible:outline-primary"
      >
        <CircleUser className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm">Profile</span>
        {quota ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {quota.usedPercent}%
          </span>
        ) : null}
        {/* Points the way the menu will go. Closed it is an up-chevron because pressing it opens
            upward; open it flips to point back down at the row it came from. */}
        <ChevronUp
          className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none
            ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      <DesktopParkModal open={parkOpen} park={park} onClose={() => setParkOpen(false)} />

      <UsageModal
        open={modalOpen}
        state={usage.state}
        // The report is kept rather than discarded, so reopening paints instantly. The stream
        // closes itself when the sweep settles, whether or not the modal is still on screen.
        onClose={() => setModalOpen(false)}
      />
    </div>
  );
}

function vendorNames(usage: UsageHandle): string {
  const named = usage.state.kind === "ready"
    ? usage.state.report.vendors.filter((vendor) => vendor.installed).map((vendor) => vendor.displayName)
    : [];
  return named.length > 0 ? named.join(", ") : usage.vendors.join(", ");
}

function quotaOf(usage: UsageHandle) {
  if (usage.state.kind !== "ready") return null;
  return usage.state.report.vendors.find((vendor) => vendor.quota)?.quota ?? null;
}
