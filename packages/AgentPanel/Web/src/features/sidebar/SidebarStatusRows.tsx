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

/** A list that is still on screen while the stream behind it reconnects. Above the list, not instead of it. */
export function SidebarReconnecting() {
  return (
    <div role="status" aria-live="polite" className="flex justify-center px-3 py-2.5">
      <ReconnectingChip />
    </div>
  );
}
