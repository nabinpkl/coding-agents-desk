import { LoaderCircle, Plus, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { stableSessionAnchor } from "@agentdesk/agent-feed-wire";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { BotAvatar } from "@/features/bots/avatar/BotAvatar";

function sessionKey(session: Pick<SessionSummary, "source" | "sessionId">): string {
  return `${session.source}:${session.sessionId}`;
}

/**
 * Which sessions this Bot should curate, and where its first one comes from.
 *
 * Two answers, in one dialog, because they are one question asked at one moment: a Bot owns a
 * directory, and the reader wants a session of that directory on it. The list answers it when the
 * directory already has sessions. Nothing answered it when the directory had none -- which is
 * every Bot on the day it is created, and the state this dialog opened in most often. So the other
 * answer stands above the list: start one here, now, named.
 */
export function BotSessionPickerDialog({
  open,
  bot,
  sessions,
  onClose,
  onAttach,
  onStartNew,
}: {
  open: boolean;
  bot: BotView | null;
  sessions: SessionSummary[] | undefined;
  onClose: () => void;
  onAttach: (bot: BotView, sessionRefs: BotSessionRef[]) => Promise<void>;
  /**
   * Starts a fresh session in the Bot's directory under this name, and closes the dialog.
   *
   * Nothing is awaited and nothing is reported back here: the session becomes a card on the canvas
   * with its terminal in it, so the pane itself is where a failure to start would show. A dialog
   * left open over that card would only be in the way of the thing it just made.
   */
  onStartNew: (bot: BotView, title: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const attachedKeys = useMemo(
    () => new Set(bot?.sessionRefs.map(sessionKey) ?? []),
    [bot],
  );

  useEffect(() => {
    if (!open) return;
    setSelectedKeys(new Set());
    setPending(false);
    setError(null);
    // The next anchor, spent from the Bot's slot counter rather than counted from titles: two
    // presses in one minute cannot propose the same name, and a deleted session's number never
    // comes back. What the session is doing goes in brackets after it.
    setNewTitle(bot ? stableSessionAnchor(bot.name, bot.nextSessionSlot ?? bot.sessionRefs.length) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot?.botId, open]);

  useEffect(() => {
    if (!open || !sessions) return;
    const selectable = new Set(
      sessions
        .map(sessionKey)
        .filter((key) => !attachedKeys.has(key)),
    );
    setSelectedKeys((current) => {
      const next = new Set([...current].filter((key) => selectable.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [attachedKeys, open, sessions]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, [open]);

  if (!open || !bot) return null;

  const startNew = (event: FormEvent) => {
    event.preventDefault();
    const chosen = newTitle.trim();
    if (!chosen || pending || bot.environmentAvailability === "missing") return;
    onStartNew(bot, chosen);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (selectedKeys.size === 0 || pending || !sessions) return;
    const sessionRefs = sessions
      .filter((session) => selectedKeys.has(sessionKey(session)))
      .map(({ source, sessionId }) => ({ source, sessionId }));
    setPending(true);
    setError(null);
    try {
      await onAttach(bot, sessionRefs);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
      setPending(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="bot-session-picker-title"
      className="fixed inset-0 z-60 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-4 text-foreground backdrop:bg-black/45 open:flex"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section className="flex max-h-[min(680px,92dvh)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl">
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <BotAvatar bot={bot} />
          <div className="min-w-0 flex-1">
            <h2 id="bot-session-picker-title" className="truncate text-base font-semibold">Add sessions to {bot.name}</h2>
            <p className="truncate font-mono text-xs text-muted-foreground">{bot.environment.path}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Close session picker"
            className="flex size-11 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="size-5" aria-hidden />
          </button>
        </header>

        {/* Above the list, not beside it. The list is the answer when this directory already has
            sessions; this is the answer when it has none, and that reader must not have to read
            past an empty state to find it. Its own form because a form cannot nest inside
            another, and the two do different things with the same Return key. */}
        <form
          onSubmit={startNew}
          className="flex shrink-0 flex-wrap items-end gap-2 border-b border-border px-4 py-3"
        >
          <label className="min-w-40 flex-1 text-sm font-medium">
            Start a new session here
            {/* Capped where the catalog truncates, so a stored title is always the one shown. */}
            <input
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              maxLength={240}
              disabled={pending || bot.environmentAvailability === "missing"}
              className="mt-1 min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
          <button
            type="submit"
            disabled={!newTitle.trim() || pending || bot.environmentAvailability === "missing"}
            title={bot.environmentAvailability === "missing" ? "Bot directory is unavailable" : undefined}
            className="flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border px-4 text-sm font-semibold text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <SquareTerminal className="size-4" aria-hidden />
            Start
          </button>
          {/* Said before rather than discovered later: the anchor is the stable half. */}
          <p className="basis-full text-xs text-muted-foreground">
            Runs Claude in {bot.environment.path} and opens it on the canvas. The name before the
            brackets never changes; what it is doing goes inside them.
          </p>
        </form>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {!sessions ? (
              <div role="status" className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
                Loading sessions from this directory…
              </div>
            ) : sessions.length === 0 ? (
              <div role="status" className="flex min-h-40 items-center justify-center p-4 text-center text-sm text-muted-foreground">
                AgentDesk has no sessions correlated to this directory. Start one above.
              </div>
            ) : (
              <fieldset className="min-w-0">
                {/* A fieldset defaults to `min-inline-size: min-content`, so without this it
                    refuses to shrink to its column and every row's `truncate` never fires:
                    measured 1712px of rows inside a 356px list on a phone, titles running off
                    the side. */}
                <legend className="sr-only">Sessions in {bot.environment.path}</legend>
                {sessions.map((session) => {
                  const key = sessionKey(session);
                  const attached = attachedKeys.has(key);
                  const checked = selectedKeys.has(key);
                  return (
                    <label
                      key={key}
                      className={`flex min-h-12 items-start gap-3 rounded-lg px-3 py-2 outline-none transition-colors ${
                        attached
                          ? "cursor-not-allowed text-muted-foreground"
                          : "cursor-pointer hover:bg-muted focus-within:ring-2 focus-within:ring-primary active:bg-muted/80"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={attached}
                        onChange={(event) => {
                          setSelectedKeys((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(key);
                            else next.delete(key);
                            return next;
                          });
                          setError(null);
                        }}
                        className="mt-1"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{session.title || session.sessionId}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <SourceBadge source={session.source} />
                          <span>{session.capabilities.canSend ? "sendable" : "view only"}</span>
                          {attached ? <span>already attached</span> : null}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            )}
            {error ? <p role="alert" className="px-3 py-2 text-sm text-destructive">{error}</p> : null}
          </div>

          <footer className="flex min-h-14 items-center justify-between gap-3 border-t border-border px-4">
            <span className="text-xs text-muted-foreground">
              {selectedKeys.size === 0 ? "Select sessions from this project" : `${selectedKeys.size} selected`}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={pending}
                className="min-h-10 rounded-lg px-4 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={selectedKeys.size === 0 || pending}
                className="flex min-h-10 min-w-28 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
                {pending ? "Adding…" : "Add sessions"}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </dialog>
  );
}
