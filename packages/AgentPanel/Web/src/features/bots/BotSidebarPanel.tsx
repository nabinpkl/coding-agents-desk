import { Bot, EllipsisVertical, LoaderCircle, Plus, Unlink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SourceBadge } from "../sidebar/SourceBadge";

/**
 * The per-session actions menu.
 *
 * Deliberately not built on the profile menu's popover: that one roves the arrow keys across four
 * entries and anchors itself upward against the window's bottom edge, and neither applies to a
 * single item on a list row. If a third menu appears, the dismiss-and-focus behaviour below is
 * what to extract; two unlike cases are not yet an abstraction.
 */
function SessionRowMenu({
  label,
  onDetach,
}: {
  label: string;
  onDetach: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // The keyboard has to land on the action without tabbing through the rest of the roster.
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, [open]);

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) globalThis.requestAnimationFrame?.(() => trigger.current?.focus());
  };

  return (
    <span className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((current) => !current)}
        // Named for its row, not just "More": a roster of eight sessions would otherwise give a
        // screen reader eight identically named buttons with no way to tell which row it is on.
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:bg-background focus-visible:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary active:bg-background/70"
      >
        <EllipsisVertical className="size-4" aria-hidden />
      </button>
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label={`Actions for ${label}`}
          className="absolute top-full right-0 z-50 mt-1 min-w-44 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            close();
          }}
        >
          <button
            type="button"
            role="menuitem"
            // Focus goes back to the trigger, not nowhere. The removal is a request, not a fact:
            // if it fails the row is still here and the keyboard is where it left off, and if it
            // succeeds the trigger has gone with the row and the focus call is a no-op.
            onClick={() => {
              close();
              onDetach();
            }}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary active:bg-accent/80"
          >
            <Unlink className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Remove from bot</span>
          </button>
        </div>
      ) : null}
    </span>
  );
}

export function BotAvatar({ bot, size = "size-10" }: { bot: Pick<BotView, "name" | "iconUrl">; size?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [bot.iconUrl]);
  const initials = bot.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "B";
  if (bot.iconUrl && !failed) {
    return (
      <img
        src={bot.iconUrl}
        alt=""
        className={`${size} shrink-0 rounded-full border border-border object-cover`}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`${size} flex shrink-0 items-center justify-center rounded-full border border-border bg-muted font-semibold text-foreground`}
    >
      {initials}
    </span>
  );
}

function attachedSessionKey(session: BotSessionRef): string {
  return `${session.source}:${session.sessionId}`;
}

export function BotSidebarPanel({
  bots,
  loading,
  error,
  selectedBotId,
  selectedSessionKey,
  onSelectSession,
  onAddSession,
  onDetachSession,
  onAddBot,
}: {
  bots: BotView[];
  loading: boolean;
  error: string | null;
  selectedBotId: string | null;
  selectedSessionKey: string | null;
  onSelectSession: (bot: BotView, session: SessionSummary) => void;
  onAddSession: (bot: BotView) => void;
  /**
   * Drops the reference from the Bot's projection. The session itself is untouched.
   *
   * Takes a reference rather than a summary because the rows that most need this are the ones
   * with no summary left: a transcript the catalog has forgotten shows as "missing" and would
   * otherwise be the one entry a Bot can never be rid of.
   */
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  onAddBot: () => void;
}) {
  return (
    <div className="min-h-0">
      <button
        type="button"
        onClick={onAddBot}
        className="flex min-h-11 w-full cursor-pointer items-center gap-2 border-b border-border px-3 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-primary/15"
      >
        <Plus className="size-4" aria-hidden />
        Add Bot
      </button>
      {loading ? (
        <div role="status" className="flex min-h-28 items-center justify-center gap-2 p-4 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          Loading Bots…
        </div>
      ) : error ? (
        <div role="alert" className="p-4 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
          Bots unavailable: {error}
        </div>
      ) : bots.length === 0 ? (
        <div role="status" className="flex min-h-28 flex-col items-center justify-center gap-2 p-4 text-center text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          <Bot className="size-5" aria-hidden />
          No bots yet
        </div>
      ) : (
        <ul role="list" aria-label="Bots">
          {bots.map((bot) => {
            const projectName = bot.environment.path.split("/").filter(Boolean).at(-1) ?? bot.environment.path;
            const selected = bot.botId === selectedBotId;
            return (
              <li key={bot.botId} className="border-b border-border/80">
                <div className={`flex min-h-16 items-center gap-3 border-l-2 px-3 py-2 ${selected ? "border-primary bg-muted" : "border-transparent"}`}>
                  <BotAvatar bot={bot} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-(length:--agent-panel-fs-sidebar-body,15px) font-semibold text-foreground">
                      {bot.name}
                    </span>
                    {bot.metadata.role ? (
                      <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
                        {bot.metadata.role}
                      </span>
                    ) : null}
                    <span className="mt-0.5 block truncate font-mono text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
                      {projectName}
                      {bot.environmentAvailability === "missing" ? " · missing directory" : ""}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onAddSession(bot)}
                    disabled={bot.environmentAvailability === "missing"}
                    aria-label={`Add sessions to ${bot.name}`}
                    title={bot.environmentAvailability === "missing" ? "Bot directory is unavailable" : "Add sessions"}
                    className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-background/70 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="size-4" aria-hidden />
                  </button>
                </div>

                {bot.sessions.length > 0 || bot.missingSessionRefs.length > 0 ? (
                  <ul role="list" aria-label={`${bot.name} sessions`} className="pb-1">
                    {bot.sessions.map((session) => {
                      const key = attachedSessionKey(session);
                      const active = selected && selectedSessionKey === key;
                      return (
                        // The row was one button until it grew a second action. A button cannot
                        // contain a button, so opening the session and opening its menu are now
                        // siblings, and the row's selected tint moves up to the item that holds
                        // both.
                        <li
                          key={key}
                          className={`flex items-center pr-1.5 ${active ? "bg-muted" : ""}`}
                        >
                          <button
                            type="button"
                            onClick={() => onSelectSession(bot, session)}
                            aria-current={active ? "page" : undefined}
                            className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pr-2 pl-14 text-left text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80"
                          >
                            <span className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-meta,13px)">
                              {session.title || session.sessionId}
                            </span>
                            <SourceBadge source={session.source} />
                            {!session.capabilities.canSend ? <span className="text-[11px] text-muted-foreground">view only</span> : null}
                          </button>
                          <SessionRowMenu
                            label={session.title || session.sessionId}
                            onDetach={() => onDetachSession(bot, session)}
                          />
                        </li>
                      );
                    })}
                    {bot.missingSessionRefs.map((ref) => (
                      <li key={attachedSessionKey(ref)} className="flex min-h-9 items-center gap-2 py-1 pr-1.5 pl-14 text-xs text-muted-foreground">
                        <span className="min-w-0 flex-1 truncate">{ref.sessionId}</span>
                        <SourceBadge source={ref.source} />
                        <span>missing</span>
                        <SessionRowMenu
                          label={ref.sessionId}
                          onDetach={() => onDetachSession(bot, ref)}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="pb-2 pr-3 pl-14 text-xs text-muted-foreground">No sessions attached</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
