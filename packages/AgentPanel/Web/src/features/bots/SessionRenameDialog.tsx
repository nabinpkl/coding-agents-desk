import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";

/**
 * Renaming one session, in the smallest dialog that can carry a field and a failure.
 *
 * App-level rather than inside the row that opened it, because the same menu is rendered by the
 * sidebar and by the canvas: a dialog per row would be two of them, and the one on the canvas
 * would be inside a card that scrolls sideways.
 */
export function SessionRenameDialog({
  session,
  onClose,
  onRename,
}: {
  /** The session being renamed, or null when the dialog is closed. */
  session: SessionSummary | null;
  onClose: () => void;
  onRename: (session: SessionSummary, title: string) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seeded from the session rather than left empty: a rename is usually an edit of the name that
  // is there, and starting blank makes the reader retype what they can already see.
  useEffect(() => {
    if (!session) return;
    setTitle(session.title || session.sessionId);
    setPending(false);
    setError(null);
  }, [session]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !session || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    globalThis.requestAnimationFrame?.(() => field.current?.select());
  }, [session]);

  if (!session) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !title.trim()) return;
    setPending(true);
    setError(null);
    try {
      await onRename(session, title.trim());
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
      setPending(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="session-rename-title"
      className="fixed inset-0 z-60 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-4 text-foreground backdrop:bg-black/45 open:flex"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-border bg-card p-4 text-foreground shadow-2xl"
      >
        <h2 id="session-rename-title" className="text-base font-semibold">Rename session</h2>
        <label className="block text-sm font-medium">
          Title
          {/* Capped where the catalog truncates, so a stored title is always the one shown. */}
          <input
            ref={field}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={240}
            className="mt-1 min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
        </label>
        {/* Said here rather than discovered afterwards: a reader who renames a session to address
            it from another one would otherwise find the old name still answering. */}
        <p className="text-xs text-muted-foreground">
          Changes the name shown here and in <code>/resume</code>. The address other sessions
          message it by is fixed when the session starts and does not change.
        </p>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center justify-end gap-2">
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
            disabled={!title.trim() || pending}
            className="flex min-h-10 min-w-24 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
            {pending ? "Renaming…" : "Rename"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
