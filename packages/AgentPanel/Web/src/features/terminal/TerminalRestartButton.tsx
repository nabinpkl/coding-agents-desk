// Runs a Claude session again in the pane this footer shows, under the sidecar's launch argv as
// it is now. What that is for is the permission flags: a session keeps the mode it was launched
// with until its process is replaced.
//
// Two presses, because the first one ends whatever the session is doing, a turn in flight
// included. The second has to come within a few seconds, so a stray tap cannot arm it for later.

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import type { SessionTmuxTerminalContext } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { useTimeout } from "@/hooks/useInterval";

const CONFIRM_WINDOW_MS = 4_000;

type RestartState = { kind: "idle" } | { kind: "armed" } | { kind: "restarting" } | { kind: "failed"; message: string };

export function TerminalRestartButton({
  feed,
  context,
}: {
  feed: SidecarDataSource;
  context: SessionTmuxTerminalContext;
}) {
  const [state, setState] = useState<RestartState>({ kind: "idle" });

  // Disarms on its own, so the second press means "yes, now" rather than whenever.
  useTimeout(() => setState({ kind: "idle" }), state.kind === "armed" ? CONFIRM_WINDOW_MS : null);

  const press = (): void => {
    if (state.kind === "restarting") return;
    if (state.kind !== "armed") {
      setState({ kind: "armed" });
      return;
    }
    setState({ kind: "restarting" });
    feed.restartSessionTerminal(context).then(
      () => setState({ kind: "idle" }),
      (failure: unknown) =>
        setState({ kind: "failed", message: failure instanceof Error ? failure.message : String(failure) }),
    );
  };

  const armed = state.kind === "armed";
  const label = armed
    ? "Press again to restart this session"
    : state.kind === "restarting"
      ? "Restarting session"
      : "Restart this session with the current launch flags";
  return (
    <>
      {state.kind === "failed" ? (
        <span role="status" title={state.message} className="min-w-0 truncate text-destructive">
          Restart failed: {state.message}
        </span>
      ) : null}
      <button
        type="button"
        onClick={press}
        disabled={state.kind === "restarting"}
        aria-label={label}
        title={label}
        className={
          "flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded px-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default disabled:opacity-60 " +
          (armed
            ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
            : "hover:bg-muted hover:text-foreground")
        }
      >
        <RotateCcw className={`size-3 ${state.kind === "restarting" ? "motion-safe:animate-spin" : ""}`} aria-hidden />
        {armed ? "Restart?" : "Restart"}
      </button>
    </>
  );
}
