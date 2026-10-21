// The sidebar's own arrangement: which view it shows, how wide it is, and how it is revealed.
//
// One owner for all three renderings of it -- the pinned desktop rail, the hover preview, and the
// phone drawer -- because they must never disagree about which view is selected or whether the
// sidebar is open. Its own file because none of it is about a session, a project, or a Bot: it is
// the chrome the reader arranged, and all of it is remembered.

import { useCallback, useRef, useState } from "react";
import type { AgentSidebarMode } from "@/features/sidebar/AgentSidebar";
import type { CanvasSidebarView } from "@/features/sidebar/CanvasSidebarViews";
import { useSidebarEnvironment } from "@/features/sidebar/SidebarPresentation";
import { loadSidebarPreferences, storeSidebarPreferences } from "@/features/sidebar/sidebarPreferences";
import { searchWithSidebarMode, sidebarModeFromSearch } from "@/features/sidebar/sidebarRoute";
import { useUnmountEffect } from "@/hooks/useMountEffect";
import { useNotify } from "@/hooks/useNotify";

/**
 * `canvasOnly` holds the sidebar on its Canvas view and leaves the remembered view and the address
 * alone, for a tab that shows nothing else (Branches): its choice is not the reader's, so it must
 * not overwrite the one the Feed tab comes back to.
 */
export function useSidebarChrome({ canvasOnly = false }: { canvasOnly?: boolean } = {}) {
  const { compact, hoverCapable } = useSidebarEnvironment();
  /**
   * The sidebar's arrangement, with the address bar ahead of what was stored.
   *
   * The address is what a reload actually carries, so it wins whenever it names a view. Storage
   * answers the case it cannot -- a fresh tab typed as the bare origin -- and the address is then
   * written to match, so from the first paint there is one place to read the answer from rather
   * than two that can drift.
   */
  const [sidebarPreferences, setSidebarPreferences] = useState(() => {
    const stored = loadSidebarPreferences();
    const asked = typeof window === "undefined" ? null : sidebarModeFromSearch(window.location.search);
    return asked === null ? stored : { ...stored, mode: asked };
  });
  // One owner for every rendering of the sidebar: the pinned desktop rail, hover preview,
  // and phone drawer must never disagree about which view is selected.
  const sidebarMode: AgentSidebarMode = canvasOnly ? "canvas" : sidebarPreferences.mode;
  // Written on every change of the view rather than only on a press, so the address is right after
  // a restore from storage too. `replaceState` rather than `pushState`: choosing a view is not a
  // navigation, and making Back walk the tabs would take a reader out of the panel to leave it.
  useNotify(sidebarMode, () => {
    if (canvasOnly || typeof window === "undefined") return;
    if (sidebarModeFromSearch(window.location.search) === sidebarMode) return;
    try {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${searchWithSidebarMode(window.location.search, sidebarMode)}${window.location.hash}`,
      );
    } catch {
      // A custom-scheme container may refuse to rewrite its address; the panel does not need it to.
    }
  });

  // Width owns composition. A fine pointer may change desktop affordances, but
  // it must not turn a compact layout back into two side-by-side columns.
  //
  // It does NOT own whether hovering works. Those are separate facts -- one about the window,
  // one about the input device -- and conflating them meant a 480pt Agents window on a Mac was
  // handed the touch story and stopped responding to the mouse it still had. Width decides
  // whether the sidebar can sit beside the content; the pointer decides whether pointing at the
  // trigger is enough to reveal it.
  const usesModalSidebar = compact;
  const sidebarPinned = !usesModalSidebar && sidebarPreferences.open;
  const drawerOpen = usesModalSidebar && sidebarPreferences.open;
  const [hoverPreviewOpen, setHoverPreviewOpen] = useState(false);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Leaving the panel is the one hover that never resolves, because the component goes with it.
  useUnmountEffect(() => {
    if (hoverCloseTimer.current !== null) clearTimeout(hoverCloseTimer.current);
  });

  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarPreferences((current) => {
      if (current.open === open) return current;
      const next = { ...current, open };
      storeSidebarPreferences(next);
      return next;
    });
  }, []);

  const previewSidebarWidth = useCallback((width: number) => {
    setSidebarPreferences((current) => (current.width === width ? current : { ...current, width }));
  }, []);

  const commitSidebarWidth = useCallback((width: number) => {
    setSidebarPreferences((current) => {
      const next = current.width === width ? current : { ...current, width };
      storeSidebarPreferences(next);
      return next;
    });
  }, []);

  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimer.current === null) return;
    clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = null;
  }, []);

  const revealSidebarOnHover = useCallback(() => {
    cancelHoverClose();
    // Not gated on width: see `usesModalSidebar`. The two surfaces it IS gated on are the ones
    // that already show the same list -- the pinned rail and the modal drawer -- because a
    // transient copy layered over either of them is two navigations for one pointer.
    if (hoverCapable && !sidebarPinned && !drawerOpen) setHoverPreviewOpen(true);
  }, [cancelHoverClose, drawerOpen, hoverCapable, sidebarPinned]);

  const hideSidebarAfterHover = useCallback(() => {
    cancelHoverClose();
    hoverCloseTimer.current = setTimeout(() => {
      hoverCloseTimer.current = null;
      setHoverPreviewOpen(false);
    }, 120);
  }, [cancelHoverClose]);

  /**
   * The trigger's press, at either width.
   *
   * Hover peeks; pressing commits to the surface the width allows -- the pinned rail when there
   * is room beside the content, the modal drawer that traps focus and answers Escape when there
   * is not. One callback because the choice is already made downstream by `usesModalSidebar`;
   * `sidebarPreferences.open` means the same thing to both. The peek is dropped first so the two
   * never stack.
   */
  const openSidebar = useCallback(() => {
    cancelHoverClose();
    setHoverPreviewOpen(false);
    setSidebarOpen(true);
  }, [cancelHoverClose, setSidebarOpen]);

  const dismissHoverPreview = useCallback(() => {
    cancelHoverClose();
    setHoverPreviewOpen(false);
    globalThis.requestAnimationFrame?.(() => drawerTriggerRef.current?.focus());
  }, [cancelHoverClose]);

  const closePinnedSidebar = useCallback(() => {
    setSidebarOpen(false);
    globalThis.requestAnimationFrame?.(() => drawerTriggerRef.current?.focus());
  }, [setSidebarOpen]);

  /**
   * Choosing Canvas on a phone closes the drawer that was used to choose it.
   *
   * Sessions and Bots put their content INSIDE the drawer, so it stays open and the reader keeps
   * picking. The canvas is the main panel, so leaving the drawer up would cover the only thing
   * the tab was pressed for with a panel that has almost nothing on it.
   */
  const changeSidebarMode = useCallback(
    (mode: AgentSidebarMode) => {
      setSidebarPreferences((current) => {
        if (current.mode === mode) return current;
        const next = { ...current, mode };
        storeSidebarPreferences(next);
        return next;
      });
      if (mode === "canvas") {
        setHoverPreviewOpen(false);
        if (usesModalSidebar) setSidebarOpen(false);
      }
    },
    [setSidebarOpen, usesModalSidebar],
  );

  const changeCanvasView = useCallback((canvasView: CanvasSidebarView) => {
    setSidebarPreferences((current) => {
      if (current.canvasView === canvasView) return current;
      const next = { ...current, canvasView };
      storeSidebarPreferences(next);
      return next;
    });
  }, []);

  const changeCanvasSessionsGrouped = useCallback((canvasSessionsGrouped: boolean) => {
    setSidebarPreferences((current) => {
      if (current.canvasSessionsGrouped === canvasSessionsGrouped) return current;
      const next = { ...current, canvasSessionsGrouped };
      storeSidebarPreferences(next);
      return next;
    });
  }, []);

  /** The Canvas tab's flat sessions list is on screen, so the inventory stream should carry it. */
  const recentSessionsShowing =
    sidebarMode === "canvas" &&
    sidebarPreferences.canvasView === "sessions" &&
    !sidebarPreferences.canvasSessionsGrouped;

  return {
    canvasOnly,
    compact,
    hoverCapable,
    cancelHoverClose,
    sidebarMode,
    sidebarPreferences,
    usesModalSidebar,
    sidebarPinned,
    drawerOpen,
    hoverPreviewOpen,
    setHoverPreviewOpen,
    drawerTriggerRef,
    setSidebarOpen,
    previewSidebarWidth,
    commitSidebarWidth,
    revealSidebarOnHover,
    hideSidebarAfterHover,
    openSidebar,
    dismissHoverPreview,
    closePinnedSidebar,
    changeSidebarMode,
    changeCanvasView,
    changeCanvasSessionsGrouped,
    recentSessionsShowing,
  };
}
