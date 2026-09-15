"use client";

// The strip that appears when this page is deliberately behind the tree.
//
// The dev server holds a `.ts` change until the tree typechecks, so "the panel did not update" now
// has two meanings that look identical from the outside: it is being withheld, or it is broken.
// This is the difference, said in the one place that is on screen in every surface, and only when
// there is something to say -- at rest it renders nothing at all.
//
// It sits BELOW the profile trigger rather than inside it because the trigger is a button and the
// override is a button, and one cannot hold the other.

import type { PanelBuild } from "@/features/profile/panelBuild";

const PUBLISH_CLASS =
  "shrink-0 rounded-sm border border-border px-1.5 py-0.5 font-medium text-foreground " +
  "outline-none transition-colors hover:border-primary hover:text-primary " +
  "focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary active:opacity-70";

export function PanelBuildStatus({ build }: { build: PanelBuild }) {
  if (!build.connected) return null;

  if (build.unfiltered) {
    return (
      <p className="px-3 pb-1 text-[11px] leading-tight text-amber-500">
        No typechecker: edits arrive unfiltered.
      </p>
    );
  }

  if (build.held.length === 0) return null;

  const count = `${build.held.length} ${build.held.length === 1 ? "change" : "changes"}`;
  return (
    <div className="space-y-0.5 px-3 pb-1 text-[11px] leading-tight">
      <div className="flex items-center gap-2">
        <span className={build.blocked ? "text-amber-500" : "text-muted-foreground"}>
          {build.checking ? `${count} held, checking` : `${count} held`}
        </span>
        <button
          type="button"
          className={PUBLISH_CLASS}
          onClick={build.publish}
          title={`Hand over ${build.held.join(", ")} without waiting for the typechecker`}
        >
          Publish
        </button>
      </div>
      {/* The reason, when there is one. Truncated rather than wrapped: the sidebar is narrow, and
          the whole message is one hover away. */}
      {build.blocked ? (
        <p className="truncate font-mono text-amber-500/80" title={build.blocked}>
          {build.blocked}
        </p>
      ) : (
        <p className="truncate font-mono text-muted-foreground/70" title={build.held.join(", ")}>
          {build.held.join(", ")}
        </p>
      )}
    </div>
  );
}
