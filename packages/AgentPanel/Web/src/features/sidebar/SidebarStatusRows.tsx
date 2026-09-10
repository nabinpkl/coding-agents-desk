"use client";

import { LoaderCircle } from "lucide-react";

// The one-line rows a sidebar shows instead of content: loading, empty, and failed.

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
