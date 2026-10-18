// An edit's diff, loaded when a row first shows one rather than with the feed.
//
// `@git-diff-view` brings its own highlighter, every language `highlight.js` has: 1.44MB of source,
// 369KB over the wire. Imported with the feed, it was the last thing a phone's first paint waited
// for (measured 2026-10-18: requested at 4.0s, done at 9.1s, `DOMContentLoaded` at 9.28s), for a
// block that only draws when a reader expands an edit.
//
// Only a component is exported, so React Fast Refresh takes an edit here in place.

import { lazy, Suspense, type ComponentProps } from "react";
import type { DiffBlock } from "@/features/activity-feed/blocks/diff/DiffBlock";

const LoadedDiffBlock = lazy(() =>
  import("@/features/activity-feed/blocks/diff/DiffBlock").then((module) => ({ default: module.DiffBlock })),
);

export function DiffBlockOnDemand(props: ComponentProps<typeof DiffBlock>) {
  return (
    <Suspense
      fallback={
        <div
          role="status"
          className="rounded-sm border border-border/60 px-[0.55em] py-[0.4em] text-muted-foreground"
          style={{ fontSize: "var(--agent-panel-fs-tile-diff, 14px)" }}
        >
          Loading diff…
        </div>
      }
    >
      <LoadedDiffBlock {...props} />
    </Suspense>
  );
}
