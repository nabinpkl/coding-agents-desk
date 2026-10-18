"use client";

// The strip that appears when this page is deliberately behind the tree.
//
// The dev server holds a `.ts` change back while the file does not parse, so "the panel did not
// update" now has two meanings that look identical from the outside: it is being withheld, or it
// is broken. This is the difference, said in the one place that is on screen in every surface, and
// only when there is something to say -- at rest it renders nothing at all.
//
// It gained a control when the reader gained a choice. While updates are applied as they land there
// is nothing to decide, and a file that will not parse is not a decision either -- what clears that
// is finishing the edit. Manual mode is the case with an action in it: whole files queue up, and
// the only way to hand them over is a reload, because an update Vite was not allowed to send is
// gone rather than parked. So the button says Apply and means "reload onto the tree as it is now",
// and it is refused while anything in the queue is still half a file.
//
// Held sidecars are a different decision and have their own button, under their rows. Restarting
// drops every stream the panel holds from them, so it never rides along with a panel reload: one
// Apply used to do both, and taking a panel change restarted every sidecar under every surface.
// It restarts every waiting machine together, because the Mac and a peer run one tree between
// them and a reader taking it on one wants it on both.
//
// The mode is also said out loud with nothing waiting, which is the one piece of standing text here
// that earns its line: a panel that has stopped updating because the reader asked it to, an hour
// ago, is indistinguishable from a broken one otherwise.
//
// It sits BELOW the profile trigger rather than inside it, since the trigger is a button.

import type { PanelBuild } from "@/features/profile/panelBuild";

export function PanelBuildStatus({ build }: { build: PanelBuild }) {
  if (!build.connected) return null;
  const manual = build.mode === "manual";
  const waiting = build.held.length;
  if (waiting === 0 && build.sidecars.length === 0 && !manual) return null;

  const count = `${waiting} ${waiting === 1 ? "file" : "files"}`;
  // Machines a restart would move: held on the reader's say-so, with a tree that parses. One
  // stuck on half a file refuses the restart itself, so it neither enables nor blocks the button.
  const restartable = build.sidecars.filter(
    (sidecar) => sidecar.held && sidecar.mode === "manual" && sidecar.blocked === null,
  );
  return (
    <div className="space-y-1 px-3 pb-1 text-[11px] leading-tight">
      {manual || waiting > 0 ? (
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className={waiting > 0 ? "text-amber-500" : "text-muted-foreground"}>
              {waiting === 0 ? "updates manual" : manual ? `${count} waiting` : `${count} held back`}
            </span>
            {manual && waiting > 0 ? (
              <button
                type="button"
                onClick={build.apply}
                disabled={build.blocked !== null}
                title={
                  build.blocked
                    ? `Cannot apply yet: ${build.blocked}`
                    : "Reload every open surface onto the panel as it is now. No sidecar restarts."
                }
                className={ROW_BUTTON}
              >
                Apply
              </button>
            ) : null}
          </div>
          {/* Why, truncated rather than wrapped: the sidebar is narrow and the whole message is one
              hover away. With nothing broken this is the queue itself, which is what the reader is
              deciding about. */}
          {waiting > 0 ? <Reason text={build.blocked} fallback={build.held.join(", ")} /> : null}
        </div>
      ) : null}

      {/* The same two facts about the other processes, one line per machine: a session on an ssh
          peer is served by that peer's own sidecar and gated by that peer's own supervisor, and a
          reader looking at its feed cannot otherwise tell a held sidecar from a session gone quiet.
          Waiting and stuck are said differently because only one of them is the reader's doing --
          and the machine's own mode decides which, since a supervisor that restarted comes back on
          auto whatever this panel last asked for. */}
      {/* Behind with nothing held is the third case: the sidecar runs older code than this Mac's
          tree and its own tree has nothing newer. A peer is shipped to automatically, so this is a
          ship that stopped arriving; restarting would start the same code again, so the reason
          points at the ship job instead. */}
      {build.sidecars.map((sidecar) => (
        <div key={sidecar.machine} className="space-y-0.5">
          <span className="text-amber-500">
            {sidecar.machine} sidecar{" "}
            {!sidecar.held ? "behind" : sidecar.blocked === null && sidecar.mode === "manual" ? "waiting" : "held back"}
          </span>
          <Reason
            text={sidecar.blocked}
            fallback={
              !sidecar.held
                ? "older code than this Mac, and no newer files arrived; check its ship job"
                : sidecar.mode === "manual"
                  ? "its tree moved; Restart takes it"
                  : "a file it watches will not parse"
            }
          />
        </div>
      ))}
      {restartable.length > 0 ? (
        <button
          type="button"
          onClick={build.restartSidecars}
          title={
            `Restart the ${restartable.map((sidecar) => sidecar.machine).join(" and ")} ` +
            `${restartable.length === 1 ? "sidecar" : "sidecars"} onto the tree as it is now.` +
            " Every stream from them reconnects; the panel does not reload."
          }
          className={ROW_BUTTON}
        >
          Restart sidecars
        </button>
      ) : null}
    </div>
  );
}

/** The row's one control, sized for a line of 11px text. */
const ROW_BUTTON =
  "shrink-0 cursor-pointer rounded border border-border px-1.5 py-0.5 text-[10px]" +
  " font-medium transition-colors hover:bg-accent hover:text-accent-foreground" +
  " active:bg-accent/80 focus-visible:outline-2 focus-visible:-outline-offset-2" +
  " focus-visible:outline-primary disabled:cursor-not-allowed disabled:border-border/50" +
  " disabled:text-muted-foreground disabled:hover:bg-transparent";

/** One line of why, in the colour the reason earns. */
function Reason({ text, fallback }: { text: string | null; fallback: string }) {
  const shown = text ?? fallback;
  return (
    <p className={`truncate font-mono ${text ? "text-amber-500/80" : "text-muted-foreground/70"}`} title={shown}>
      {shown}
    </p>
  );
}
