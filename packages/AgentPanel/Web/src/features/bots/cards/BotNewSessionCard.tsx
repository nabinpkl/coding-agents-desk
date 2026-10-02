import { ChevronDown, SquareTerminal, X } from "lucide-react";
import { useState } from "react";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { AgentTerminalPane } from "@/features/terminal/AgentTerminalPane";
import { SessionAvatar } from "@/features/bots/SessionAvatar";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { RowMenu } from "@/features/bots/menus/RowMenu";
import { useCardResize } from "@/features/bots/cards/useCardResize";
import type { BotCardSize } from "@/features/bots/canvas/botCanvasPreferences";

/** A session this panel started, before the catalog has ever heard of it. */
export interface NewBotSession {
  botId: string;
  /** The id the Bot started it under, and the one it will be listed under. */
  sessionId: string;
  /** Chosen by the reader before anything started, and passed to the CLI as `-n`. */
  title: string;
  /** Where it is running: the Bot's directory, or a worktree the Bot made for it. */
  projectPath: string;
  /**
   * The pane it is running in, as the Bot reported it.
   *
   * Taken rather than derived. The pane name is the sidecar's rule -- `agentdesk-<id>` for a fresh
   * session, `agentdesk-fork-<id>` for a fork -- and a card that rebuilt it here would be a second
   * copy of that rule, in a page, that goes wrong silently the day the first one changes.
   */
  tmuxSession: string;
  /** The title of the session this one was forked from, when it is a fork. */
  forkedFrom?: string;
  /** Why a fork could not be moved back to the message it was asked to start from, if it was. */
  rewindFailed?: string;
}

/**
 * A session that is running and is not yet a session, in the card it will keep.
 *
 * The gap this fills is real and cannot be designed away: `claude` writes no transcript until its
 * first turn (measured 2026-09-08 -- the process, its registry row and its `-n` name all exist
 * immediately, the `.jsonl` does not), and everything else in this panel reads sessions from
 * transcripts. So for the minute between starting a session and typing into it there is nothing
 * for the catalog to publish, nothing for the Bot to curate, and no `SessionSummary` to render.
 *
 * What there IS, from the first second, is the tmux pane. That is the whole card: the terminal,
 * which is also the only thing a session with no history could usefully show, and which is what
 * makes the session real by being typed into.
 *
 * The card is keyed `source:sessionId` like every other, so when the transcript finally appears
 * and the Bot picks the session up, the ordinary card takes this one's place in the same slot,
 * still open, still the same width. The reader sees the transcript arrive above their terminal
 * rather than a card moving.
 *
 * Closing it before that first turn attaches nothing and leaves the tmux session running, which
 * is the same reading the fork pane takes: the session exists either way, and it can be attached
 * by hand like any other once it has spoken.
 */
export function BotNewSessionCard({
  feed,
  session,
  open,
  onToggle,
  size,
  onResize,
  onResizeCommit,
  onClose,
}: {
  feed: SidecarDataSource;
  session: NewBotSession;
  open: boolean;
  onToggle: () => void;
  size: BotCardSize;
  onResize: (size: BotCardSize) => void;
  onResizeCommit: (size: BotCardSize) => void;
  onClose: () => void;
}) {
  // What the terminal takes its height as a share of. A band pane cannot measure its own parent --
  // it IS the band -- so without this it asks the viewport, which is most of a screen and more
  // than the whole card. State rather than a ref, because the pane has to render again once the
  // node exists; a ref would still be null when its effects ran.
  const [body, setBody] = useState<HTMLElement | null>(null);
  const resize = useCardResize({
    name: session.title,
    noun: "session",
    size,
    canResizeWidth: open,
    canResizeHeight: open,
    onResize,
    onResizeCommit,
  });
  return (
    <li className="shrink-0" style={{ width: open ? resize.width : NEW_SESSION_SPINE_WIDTH }}>
      <div
        className={`flex overflow-hidden rounded-lg border ${open ? "border-primary" : "border-border"}`}
        style={open ? { height: resize.height } : undefined}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <div className={`flex shrink-0 items-start pr-1.5 ${open ? "bg-muted" : ""}`}>
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-2 py-2 pr-2 pl-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80"
            >
              {/* Live, and not a guess: this card only exists while a process this panel started
                  is running in a pane it can see. Unshaded, because a session with no transcript
                  yet has no rank on its Bot's ladder to take a colour from. */}
              <SessionAvatar
                title={session.title}
                activity="live"
                shaded={false}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground">
                  {session.title}
                </span>
                {/* Not `SessionMeta`: that reads a summary's timestamp and activity, and this
                    session has neither yet. What it has instead is worth saying plainly, because
                    it explains why the card holds a terminal and nothing else. */}
                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
                  <SourceBadge source="claude" />
                  <span>
                    {session.forkedFrom ? `forked from ${session.forkedFrom}` : "new"}, no transcript yet
                  </span>
                </span>
              </span>
              <ChevronDown
                className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
            {/* Close, not "Remove from bot": nothing has been attached to remove. It takes the
                card off this canvas and leaves the session running, the way closing a fork does. */}
            <span className="mt-1">
              <RowMenu
                label={session.title}
                items={[{ label: "Close", icon: X, onSelect: onClose }]}
              />
            </span>
          </div>
          {open ? (
            <section
              ref={setBody}
              className="flex min-h-0 flex-1 flex-col border-t border-border"
              aria-label={`${session.title} session`}
            >
              {/* Where the transcript will be, saying why it is not there yet. The same shape the
                  fork pane takes, and for the same reason: this is not a loading state, it is a
                  session that has genuinely said nothing, and a spinner over it would promise
                  something arriving that only the reader can cause. */}
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto p-4 text-center text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
                <SquareTerminal className="size-5" aria-hidden />
                {/* The fork asked to start at a message and did not get there. It is running either
                    way, so this says what it holds rather than offering to undo it. */}
                {session.rewindFailed ? (
                  <p role="alert" className="text-destructive">
                    It could not be moved back to the message you picked, so it holds the whole
                    conversation. {session.rewindFailed}
                  </p>
                ) : null}
                <p>
                  Running in{" "}
                  <span className="font-medium text-foreground">
                    {session.projectPath.split("/").filter(Boolean).at(-1) ?? session.projectPath}
                  </span>
                  . Type below to give it its first turn; the transcript appears here once it has
                  one.
                </p>
              </div>
              <AgentTerminalPane
                feed={feed}
                // Attaching, not starting. The session is already running: the Bot started it
                // before this card existed, and opening this pane twice is the same as once.
                context={{ kind: "tmux", session: session.tmuxSession }}
                layout="band"
                heightBasis={body}
              />
            </section>
          ) : null}
          {resize.bottom}
        </div>
        {resize.edge}
      </div>
    </li>
  );
}

/**
 * How wide this card stands closed.
 *
 * The same width a closed session spine takes, because that is what it is: a name, a state, and a
 * menu. Stated here rather than imported so the two are not accidentally coupled -- a closed
 * session is a row about a transcript, and this is a row about a process.
 */
const NEW_SESSION_SPINE_WIDTH = 260;
