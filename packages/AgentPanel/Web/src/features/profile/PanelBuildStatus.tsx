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
  if (build.held.length === 0 && build.sidecars.length === 0) return null;

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

      {/* The same fact about the other processes, one per machine: a session on an ssh peer is
          served by that peer's own sidecar and gated by that peer's own supervisor, and a reader
          looking at its feed cannot otherwise tell a held sidecar from a session gone quiet. */}
      {build.sidecars.map((sidecar) => (
        <div key={sidecar.machine} className="space-y-0.5">
          <span className="text-amber-500">{sidecar.machine} sidecar held back</span>
          <Reason text={sidecar.blocked} fallback="a file it watches will not parse" />
        </div>
      ))}
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
