"use client";

import { lazy, Suspense, useCallback, useId, useMemo, useRef, useState } from "react";
import { ChevronUp, CircleUser, Gauge, LayoutGrid, Pause, RefreshCw, RotateCcw } from "lucide-react";
import { useDesktopPark, type DesktopParkHandle, type ParkDataSource } from "@/features/desktop-park/useDesktopPark";
import type { UsageQuota } from "@agentdesk/agent-feed-wire";
import { UsageModal } from "@/features/usage/UsageModal";
import { useUsage, type UsageFeed, type UsageHandle } from "@/features/usage/useUsage";
import { formatResetIn } from "@/features/usage/formatTokens";
import {
  canReceiveFragmentedVideo,
  detectMediaCapabilities,
  summarizeMediaCapabilities,
} from "@/features/profile/mediaCapabilities";
import { usePanelBuild } from "@/features/profile/panelBuild";
import { PanelBuildStatus } from "@/features/profile/PanelBuildStatus";
import { StaleSessionsModal } from "@/features/profile/StaleSessionsModal";
import { PushMenuItems } from "@/features/profile/PushMenuItems";
import {
  useStaleSessions,
  type StaleSessionsHandle,
  type StaleSessionsMachine,
} from "@/features/profile/useStaleSessions";
import { useDismissOnOutsidePress } from "@/hooks/dom/overlays";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useNow } from "@/hooks/useNow";

// Loaded when it is opened rather than with the sidebar: the park plays each window live, so it
// carries the desktop viewer's stream and viewport code, which nothing else in the sidebar needs.
const DesktopParkModal = lazy(() =>
  import("@/features/desktop-park/DesktopParkModal").then((module) => ({ default: module.DesktopParkModal })),
);

// Read here, once, rather than as the default below: React Compiler cannot reorder a default that
// reads `import.meta`, and skips the component. Each module's `import.meta.hot` is its own.
const DEV_SERVER: unknown = import.meta.hot;

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
export function ProfileRow({
  usage,
  park,
  restarts,
  // The seam `panelBuild.ts` and the error boundary already use: `import.meta.hot` cannot be stood
  // up under Vitest, and the live-updates control exists only when there is a dev server behind
  // this page, so it is the half that most needs a test.
  devServer = DEV_SERVER,
}: {
  usage: UsageHandle;
  park: DesktopParkHandle;
  restarts: StaleSessionsHandle;
  devServer?: unknown;
}) {
  const [open, setOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [parkOpen, setParkOpen] = useState(false);
  const [restartsOpen, setRestartsOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const available = usage.vendors.length > 0;

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  useDismissOnOutsidePress(open, [menu, trigger], () => setOpen(false));

  // Focus moves into the menu on open so the keyboard can reach it without tabbing past the
  // whole project tree.
  useDomSync(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>(`${MENU_ITEMS}:not([aria-disabled='true'])`)?.focus();
  }, [open]);

  const quota = quotaOf(usage);
  // Read as the menu opens and every minute it stays open, for the countdown to the next reset.
  const now = useNow(open, open ? 60_000 : null);
  // Detected once per mount. These are engine facts, not session facts: they
  // cannot change while the page is alive, and re-probing on every menu open
  // would be pretending otherwise.
  const media = useMemo(() => detectMediaCapabilities(), []);
  const build = usePanelBuild(devServer);

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
            const items = Array.from(menu.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? []).filter(
              (item) => item.getAttribute("aria-disabled") !== "true",
            );
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
            {!available ? <span className="shrink-0 text-xs text-muted-foreground">no records</span> : null}
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
            {!park.available ? <span className="shrink-0 text-xs text-muted-foreground">no yabai</span> : null}
          </button>
          {/* Every session behind the launch flags or the installed CLI, on every machine. A list
              before a restart, because which sessions that is changes every time it is asked. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              restarts.load();
              setRestartsOpen(true);
              close(false);
            }}
            className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm
              transition-colors hover:bg-accent hover:text-accent-foreground active:bg-accent/80
              focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2
              focus-visible:outline-primary"
          >
            <RotateCcw className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Restart stale sessions</span>
          </button>
          <PushMenuItems />
          {/* Whether an edit acts on anything the moment it is saved: this page's own modules, and
              every machine's sidecar, which is the half that costs more -- a restart takes every
              stream the panel is holding with it. One switch because "stop changing under me" is
              one thought. Only where there is a dev server to hold anything: a bundled panel
              receives no updates at all, so the control would be permanently dead rather than
              merely unavailable, which is the Desktop park case above. It stays server-side -- see
              `panelBuildRoute.ts` -- so this is the same answer on every surface, and the strip
              under the row is where it is said once the menu closes. */}
          {build.live ? (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={build.mode === "auto"}
              onClick={() => build.setMode(build.mode === "auto" ? "manual" : "auto")}
              title={
                build.mode === "auto"
                  ? "Edits reach this page, and restart each machine's sidecar, as they are saved." +
                    " Switch to hold them until you ask."
                  : "Edits are held, here and on every machine, until you apply them. Switch back to" +
                    " take each one as it lands."
              }
              className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm
                transition-colors hover:bg-accent hover:text-accent-foreground active:bg-accent/80
                focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2
                focus-visible:outline-primary"
            >
              {build.mode === "auto" ? (
                <RefreshCw className="size-4 shrink-0" aria-hidden />
              ) : (
                <Pause className="size-4 shrink-0" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate">Live updates</span>
              <span className="shrink-0 text-xs text-muted-foreground">{build.mode}</span>
            </button>
          ) : null}
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
                {quota.label} {quota.usedPercent}%, resets in {formatResetIn(quota.resetsAt, now)}
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
              </span>{" "}
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
        {/* Which code this tab is running. The row is the right place for it because it is the one
            thing on screen in every surface, and it has to be readable from a screenshot: the
            question it answers is usually asked by someone looking at one. Quiet by default and
            amber once the page has stopped hearing from the dev server, which is the state where
            the id stops being re-read and the page carries on looking exactly the same. */}
        <span
          title={
            build.connected
              ? `Panel build ${build.id}, re-read from the dev server. Edits reach this tab as` + " they are saved."
              : `Panel build ${build.id}. This tab has lost the dev server, so it may be` +
                " running older code than the tree. Reload it."
          }
          aria-label={
            build.connected ? `Panel build ${build.id}` : `Panel build ${build.id}, disconnected from the dev server`
          }
          className={
            "shrink-0 font-mono text-[10px] leading-none " +
            (build.connected ? "text-muted-foreground/60" : "text-amber-500")
          }
        >
          {build.id}
        </span>
        {quota ? <span className="shrink-0 font-mono text-xs text-muted-foreground">{quota.usedPercent}%</span> : null}
        {/* Points the way the menu will go. Closed it is an up-chevron because pressing it opens
            upward; open it flips to point back down at the row it came from. */}
        <ChevronUp
          className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none
            ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      <PanelBuildStatus build={build} />

      {parkOpen ? (
        <Suspense fallback={null}>
          <DesktopParkModal open park={park} onClose={() => setParkOpen(false)} />
        </Suspense>
      ) : null}

      <StaleSessionsModal open={restartsOpen} restarts={restarts} onClose={() => setRestartsOpen(false)} />

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

/** Everything the arrow keys walk, which is two roles now that one of the entries is a toggle. */
const MENU_ITEMS = "[role='menuitem'],[role='menuitemcheckbox']";

function vendorNames(usage: UsageHandle): string {
  const named =
    usage.state.kind === "ready"
      ? usage.state.report.vendors.filter((vendor) => vendor.installed).map((vendor) => vendor.displayName)
      : [];
  return named.length > 0 ? named.join(", ") : usage.vendors.join(", ");
}

/**
 * The window closest to its limit, across every vendor.
 *
 * One line here and a list in the report, because this row is a summary: the reader gets the
 * meter most likely to stop them, and the popover on the context readout is where all of them
 * are shown side by side.
 */
function quotaOf(usage: UsageHandle) {
  if (usage.state.kind !== "ready") return null;
  const quotas = usage.state.report.vendors.flatMap((vendor) => vendor.quotas);
  return quotas.reduce<UsageQuota | null>(
    (worst, quota) => (worst && worst.usedPercent >= quota.usedPercent ? worst : quota),
    null,
  );
}

/** One machine's data source, as far as the Profile row reads it. */
export type ProfileFeed = UsageFeed & ParkDataSource;

/**
 * The Profile row with its data. Usage, Desktop park and stale sessions each live in a store
 * outside React that the three sidebar mounts share, and are read here, inside the sidebar's
 * boundary, rather than handed down from `App`, where a broken edit to any of them cost the whole
 * Feed tab. `ProfileRow` itself takes the handles, so its tests stand them up directly.
 */
export function LiveProfileRow({ feed, machines }: { feed: ProfileFeed; machines: readonly StaleSessionsMachine[] }) {
  const usage = useUsage(feed);
  const park = useDesktopPark(feed);
  const restarts = useStaleSessions(machines);
  return <ProfileRow usage={usage} park={park} restarts={restarts} />;
}
