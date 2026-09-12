import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import { nextForkTitle } from "./forkTitle";

/**
 * Naming a fork before it is started.
 *
 * The name has to be chosen HERE rather than corrected afterwards, and that is a property of what
 * `-n` does rather than a preference: it sets the session's address as well as its title, so the
 * name a fork starts under is the one every other agent finds it by from its first moment. A fork
 * started as `(fork 3)` and renamed a minute later has already been listed under the wrong name,
 * and any agent that addressed it in that minute addressed something else.
 *
 * Seeded with the next free `(fork n)` for the source, which is the answer most of the time. The
 * field is selected on open so typing over it replaces it, and accepting it is one Return.
 */
export function ForkSessionDialog({
  request,
  takenTitles,
  onClose,
  onFork,
}: {
  /** The session being forked and the Bot it belongs to, or null when the dialog is closed. */
  request: { session: SessionSummary; botId: string; projectPath: string } | null;
  /** Every title already in the source's project, which is how the proposal picks its number. */
  takenTitles: readonly string[];
  onClose: () => void;
  onFork: (
    request: { session: SessionSummary; botId: string; projectPath: string },
    title: string,
  ) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  /** The text this opening wants selected, until it has been. Null once it is, or when closed. */
  const wantsSelected = useRef<string | null>(null);

  useEffect(() => {
    if (!request) return;
    const seed = nextForkTitle(request.session.title || request.session.sessionId, takenTitles);
    setTitle(seed);
    wantsSelected.current = seed;
    // Deliberately keyed on the request alone: `takenTitles` is rebuilt on every inventory push,
    // and depending on it would retype the reader's field underneath them while they are in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !request || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, [request]);

  /**
   * Selects the proposal so typing replaces it, once the field is actually showing it.
   *
   * Not done beside `showModal`: React writes the new value onto the input as a property, and that
   * clears any selection made before it lands. Measured -- selecting in a frame callback after
   * `showModal` left the caret at one end and nothing highlighted, so the reader had to clear the
   * field by hand, which is most of what this dialog exists to avoid.
   *
   * It waits for the field to hold the exact text this opening seeded, rather than for any value,
   * because both of the other spellings are wrong in one direction. Firing on the title alone
   * misses a REOPEN with the same proposal, where `setTitle` writes the value it already has and
   * React skips the render -- measured, and the second open selected nothing. Firing on the request
   * alone runs while the previous proposal is still in the field, and selects that.
   */
  useEffect(() => {
    if (wantsSelected.current === null) return;
    if (!field.current || field.current.value !== wantsSelected.current) return;
    wantsSelected.current = null;
    field.current.select();
  }, [request, title]);

  if (!request) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const chosen = title.trim();
    if (!chosen) return;
    onFork(request, chosen);
  };

  const source = request.session.title || request.session.sessionId;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="session-fork-title"
      className="fixed inset-0 z-60 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-4 text-foreground backdrop:bg-black/45 open:flex"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-border bg-card p-4 text-foreground shadow-2xl"
      >
        <h2 id="session-fork-title" className="text-base font-semibold">Fork session</h2>
        <p className="text-sm text-muted-foreground">
          Branches <span className="font-medium text-foreground">{source}</span> into a new session
          in its own pane. The original is untouched.
        </p>
        <label className="block text-sm font-medium">
          Name
          {/* Capped where the catalog truncates, so a stored title is always the one shown. */}
          <input
            ref={field}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={240}
            className="mt-1 min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
        </label>
        {/* Said before rather than discovered later: this is the one moment the name is free. */}
        <p className="text-xs text-muted-foreground">
          Sets the name everywhere at once &mdash; here, in <code>/resume</code>, and the one other
          agents message it by. Forks of one session share a name unless you give them their own.
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-10 rounded-lg px-4 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim()}
            className="flex min-h-10 min-w-24 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Fork
          </button>
        </div>
      </form>
    </dialog>
  );
}
