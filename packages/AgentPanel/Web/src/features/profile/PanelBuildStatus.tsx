"use client";

// The strip that appears when this page is deliberately behind the tree.
//
// The dev server holds a `.ts` change back while the file does not parse, so "the panel did not
// update" now has two meanings that look identical from the outside: it is being withheld, or it
// is broken. This is the difference, said in the one place that is on screen in every surface, and
// only when there is something to say -- at rest it renders nothing at all.
//
// There is no control here, because there is no decision to take: a file that parses is handed over
// at once, and handing over one that does not would be asking for the broken page on purpose. What
// clears this row is finishing the edit.
//
// It sits BELOW the profile trigger rather than inside it, since the trigger is a button.

import type { PanelBuild } from "@/features/profile/panelBuild";

export function PanelBuildStatus({ build }: { build: PanelBuild }) {
  if (!build.connected) return null;

  const sidecarHeld = build.sidecar?.held === true;
  if (build.held.length === 0 && !sidecarHeld) return null;

  const count = `${build.held.length} ${build.held.length === 1 ? "file" : "files"}`;
  return (
    <div className="space-y-1 px-3 pb-1 text-[11px] leading-tight">
      {build.held.length > 0 ? (
        <div className="space-y-0.5">
          <span className="text-amber-500">{count} held back</span>
          {/* Why, truncated rather than wrapped: the sidebar is narrow and the whole message is one
              hover away. */}
          <Reason text={build.blocked} fallback={build.held.join(", ")} />
        </div>
      ) : null}

      {/* The same fact about the other process, which gates its own restarts the same way. */}
      {sidecarHeld ? (
        <div className="space-y-0.5">
          <span className="text-amber-500">Sidecar held back</span>
          <Reason text={build.sidecar?.blocked ?? null} fallback="a file it watches will not parse" />
        </div>
      ) : null}
    </div>
  );
}

/** One line of why, in the colour the reason earns. */
function Reason({ text, fallback }: { text: string | null; fallback: string }) {
  const shown = text ?? fallback;
  return (
    <p
      className={`truncate font-mono ${text ? "text-amber-500/80" : "text-muted-foreground/70"}`}
      title={shown}
    >
      {shown}
    </p>
  );
}
