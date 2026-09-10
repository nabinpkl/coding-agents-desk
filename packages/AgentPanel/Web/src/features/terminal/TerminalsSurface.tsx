import { useCallback, useEffect, useState } from "react";
import type { TmuxSessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { TerminalTile } from "@/features/terminal/TerminalTile";

type Listing =
  | { kind: "loading" }
  | { kind: "ready"; sessions: TmuxSessionSummary[] }
  | { kind: "error"; message: string };

/**
 * Every tmux session on the machine, side by side.
 *
 * The sessions are read once per visit rather than streamed: a session appearing is a thing the
 * user just did in a terminal, and one stream for the list would cost a connection this origin
 * cannot spare -- the same six-connection ceiling that put every terminal on one stream.
 */
export function TerminalsSurface({ feed }: { feed: SidecarDataSource }) {
  const [listing, setListing] = useState<Listing>({ kind: "loading" });

  const load = useCallback(() => {
    setListing({ kind: "loading" });
    void feed.listTmuxSessions()
      .then((sessions) => setListing({ kind: "ready", sessions }))
      .catch((error: unknown) => setListing({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      }));
  }, [feed]);

  useEffect(load, [load]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {listing.kind === "ready"
            ? `${listing.sessions.length} tmux ${listing.sessions.length === 1 ? "session" : "sessions"}`
            : listing.kind === "loading"
              ? "Reading tmux sessions"
              : "tmux unavailable"}
        </span>
        <button
          type="button"
          onClick={load}
          className="rounded border border-border px-2 py-1 text-xs hover:bg-card focus-visible:outline-2 focus-visible:outline-primary"
        >
          Refresh
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {listing.kind === "error" ? (
          <p className="text-xs text-muted-foreground">{listing.message}</p>
        ) : listing.kind === "ready" && listing.sessions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No tmux sessions. Start one in a terminal and refresh.
          </p>
        ) : listing.kind === "ready" ? (
          // Wrapping at the tile's own width rather than a column count. The grid is fixed, so the
          // tile has a natural size and the row breaks where the terminals stop fitting; giving it
          // a guessed pixel box instead clipped the eightieth column off every one of them.
          <div className="flex flex-wrap items-start gap-3">
            {listing.sessions.map((session) => (
              <TerminalTile key={session.name} feed={feed} session={session} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
