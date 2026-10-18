"use client";

import { LoaderCircle } from "lucide-react";
import { ReconnectingChip } from "@/features/activity-feed/ReconnectingNotice";

// The one-line rows a sidebar shows instead of content -- loading, empty, and failed -- and the one
// it shows above content that is still there while its stream reconnects.

export function SidebarStatus({ children }: { children: string }) {
  return (
    <div role="status" className="flex min-h-28 items-center justify-center p-4 text-center text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
      {children}
    </div>
  );
}

export function InlineStatus({ children }: { children: string }) {
  return (
    <div role="status" className="px-8 py-3 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
      {children}
    </div>
  );
}

export function SidebarError({
  message,
  retrying,
}: {
  message: string;
  retrying: boolean;
}) {
  return (
    <div role="alert" className="p-4 text-(length:--agent-panel-fs-sidebar-meta,13px)">
      <p className="text-destructive">{message}</p>
      {retrying ? (
        <span className="mt-1 flex items-center gap-1.5 text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" aria-hidden />
          Retrying…
        </span>
      ) : null}
    </div>
  );
}

/**
 * A list that is still on screen while the stream behind it reconnects, said over the list.
 *
 * A box of no height that sticks to the top of whatever scrolls the list, with the chip hanging out
 * of it over the first rows. In the flow it pushed the whole list down for the second or two a
 * sidecar restart takes and pulled it back up after, which is the jump this exists to avoid.
 */
export function SidebarReconnecting() {
  return (
    <div role="status" aria-live="polite" className="pointer-events-none sticky top-0 z-20 h-0 overflow-visible">
      <div className="flex justify-center px-3 pt-2.5">
        <ReconnectingChip />
      </div>
    </div>
  );
}
