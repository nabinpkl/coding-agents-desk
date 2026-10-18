import { LoaderCircle } from "lucide-react";
import { useRef, type SubmitEvent, useMemo } from "react";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import { formatBotSessionTitle, taskFromText } from "@agentdesk/agent-feed-wire";
import { useModal } from "@/hooks/dom/overlays";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useStateFor } from "@/hooks/state/useStateFor";

/**
 * Renaming one session, in the smallest dialog that can carry a field and a failure.
 *
 * App-level rather than inside the row that opened it, because the same menu is rendered by the
 * sidebar and by the canvas: a dialog per row would be two of them, and the one on the canvas
 * would be inside a card that scrolls sideways.
 */
export function SessionRenameDialog({
  session,
  anchor,
  onClose,
  onRename,
}: {
  /** The session being renamed, or null when the dialog is closed. */
  session: SessionSummary | null;
  /**
   * The session's stable anchor, when exactly one Bot holds it. Present edits only the bracket
   * task and leaves the anchor alone; absent edits the whole title the way it always has. An old
   * title seeds the task, so the first rename normalizes it instead of nesting it.
   */
  anchor?: string;
  onClose: () => void;
  onRename: (session: SessionSummary, title: string) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // Seeded from the session rather than left empty: a rename is usually an edit of the name that
  // is there, and starting blank makes the reader retype what they can already see. Under an
  // anchor the field holds only the bracket task, read the same way the sidecar reads it. All of
  // it starts over for each session, and for each anchor.
  const opening = useMemo(() => ({ session, anchor }), [session, anchor]);
  const [title, setTitle] = useStateFor(opening, () =>
    session === null
      ? ""
      : anchor ? taskFromText(session.title || session.sessionId, anchor) : (session.title || session.sessionId));
  const [pending, setPending] = useStateFor(opening, () => false);
  const [error, setError] = useStateFor<string | null>(opening, () => null);

  useModal(dialogRef, Boolean(session), { attributeFallback: true });

  /**
   * Selects the seeded name so typing replaces it, once the field is actually showing it.
   *
   * After the commit that wrote it: React writes the new value onto the input as a property, and
   * that clears any selection made before it lands. Measured on the live panel -- selecting in a
   * frame callback after `showModal` left a 17-character name focused with nothing highlighted,
   * so an edit began by clearing the field by hand. The title starts over in the same render the
   * session arrives in, so the field already holds this session's name when this runs.
   * `ForkSessionDialog` does the same for the same reasons.
   */
  useDomSync(() => {
    if (session) field.current?.select();
  }, [opening]);

  if (!session) return null;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    // Under an anchor an empty field is a bare anchor, not a missing name.
    if (pending || (!title.trim() && !anchor)) return;
    setPending(true);
    setError(null);
    try {
      await onRename(session, anchor ? formatBotSessionTitle(anchor, title.trim()) : title.trim());
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
        {anchor ? (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-sm text-foreground">
            {anchor} <span className="text-muted-foreground">(what it is doing)</span>
          </p>
        ) : null}
        <label className="block text-sm font-medium">
          {anchor ? "Task" : "Title"}
          {/* Capped where the catalog truncates, so a stored title is always the one shown. */}
          <input
            ref={field}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={240}
            className="mt-1 min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
        </label>
        {/* What a rename IS differs by source, and the reader is about to commit to it. Said here
            rather than discovered afterwards: for Claude this runs a command in the session, so it
            needs one that is running with nothing half-typed in it, and the reasons a rename can be
            refused are about the session rather than about the name. An opencode session's name is a
            label its serve holds, so nothing has to be running and no unsent text is at risk. */}
        {session.source === "opencode" ? (
          <p className="text-xs text-muted-foreground">
            Renames it on this machine&apos;s opencode serve, so the new title shows here, in the
            Bot&apos;s roster, and in opencode&apos;s own session list. The session keeps its id, so
            nothing that addresses it by id moves, and a session that is not running renames the
            same way.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Runs <code>/rename</code> in the session, so it changes the name everywhere &mdash; here,
            in <code>/resume</code>, and the one other agents message it by. The session has to be
            running, with nothing unsent in its composer.
          </p>
        )}
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
            disabled={(!title.trim() && !anchor) || pending}
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
