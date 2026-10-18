// The surfaces a page shows only some of the time, loaded when one is shown rather than with the page.
//
// Each is a large tree of its own: the desktop viewer with its stream, gesture and keyboard code,
// the IDE with its editor and file previews, the arena with its runs and diffs, and the screen
// viewer with noVNC, which alone was a fifth of the main bundle's source. Every one of them
// used to be in what the feed waited for. Measured 2026-10-18 on the iPhone, a load of the canvas
// feed fetched 122 modules for the first three (about 860KB of source) that it was not showing, over a
// link moving about 285KB/s; in a production build they sat in the one main bundle, 1.05MB gzipped,
// so an edit to any of them cost a phone the whole of it again.
//
// Only components are exported, so React Fast Refresh takes an edit here in place.

import { LoaderCircle } from "lucide-react";
import { lazy, Suspense, type ComponentProps } from "react";
import type { ArenaSurface } from "@/features/arena/ArenaSurface";
import type { DesktopViewer } from "@/features/desktop-viewer/DesktopViewer";
import type { WorkspaceIdeSurface } from "@/features/workspace-ide/WorkspaceIdeSurface";

const LoadedDesktopViewer = lazy(() =>
  import("@/features/desktop-viewer/DesktopViewer").then((module) => ({ default: module.DesktopViewer })),
);
const LoadedWorkspaceIde = lazy(() =>
  import("@/features/workspace-ide/WorkspaceIdeSurface").then((module) => ({ default: module.WorkspaceIdeSurface })),
);
const LoadedArena = lazy(() =>
  import("@/features/arena/ArenaSurface").then((module) => ({ default: module.ArenaSurface })),
);
const LoadedScreenViewer = lazy(() =>
  import("@/features/screen-viewer/ScreenViewer").then((module) => ({ default: module.ScreenViewer })),
);

/**
 * What a surface shows while its code arrives: in place of the surface, which has nothing else on
 * screen to move. A failed load throws to the surface's error boundary like any other failure.
 */
function SurfaceLoading({ name }: { name: string }) {
  return (
    <div
      role="status"
      className="flex h-full items-center justify-center gap-2 p-8 text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground"
    >
      <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
      Loading {name}…
    </div>
  );
}

export function DesktopViewerOnDemand(props: ComponentProps<typeof DesktopViewer>) {
  return (
    <Suspense fallback={<SurfaceLoading name="the desktop" />}>
      <LoadedDesktopViewer {...props} />
    </Suspense>
  );
}

export function WorkspaceIdeOnDemand(props: ComponentProps<typeof WorkspaceIdeSurface>) {
  return (
    <Suspense fallback={<SurfaceLoading name="the IDE" />}>
      <LoadedWorkspaceIde {...props} />
    </Suspense>
  );
}

export function ArenaOnDemand(props: ComponentProps<typeof ArenaSurface>) {
  return (
    <Suspense fallback={<SurfaceLoading name="the arena" />}>
      <LoadedArena {...props} />
    </Suspense>
  );
}

export function ScreenViewerOnDemand() {
  return (
    <Suspense fallback={<SurfaceLoading name="the screen" />}>
      <LoadedScreenViewer />
    </Suspense>
  );
}
