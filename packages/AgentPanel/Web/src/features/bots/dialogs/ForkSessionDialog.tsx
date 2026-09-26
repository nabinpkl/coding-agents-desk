import { Upload } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import { nextForkTitle } from "@/features/bots/dialogs/sessionTitles";

/** The sidecar's own cap on a fork brief, repeated so the dialog refuses before the round trip. */
const MAXIMUM_BRIEF = 32_768;

/**
 * What is being forked, and from where.
 *
 * `botId` and `from` are the two ways this dialog is reached, and they are mutually exclusive in
 * practice rather than by type: a Bot row forks the whole session onto that Bot, a message row
 * forks a session nobody owns and starts it just before that message. Both spend the same name,
 * the same brief and the same worktree question, which is why there is one dialog.
 */
export interface ForkRequest {
  session: SessionSummary;
  /** The directory the source runs in, which is what the proposed name is numbered against. */
  projectPath: string;
  /** The Bot to attach the fork to. Absent when the fork was asked for from a message. */
  botId?: string;
  /**
   * The message the fork starts just BEFORE, and what it says.
   *
   * The text travels with the id because it is what the fork is described by here and what the
   * sidecar proves the rewind by there: it drives Claude's own rewind picker and matches the row
   * it lands on against this string rather than trusting a count.
   */
  from?: { eventId: string; text: string };
}

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
 *
 * The brief beside it is the other thing that has to be decided here rather than after. A fork
 * starts holding its parent's context and no sense that the context is borrowed, so the moment it
 * is given something of its own is the moment it can be told which work is not its. Say it a turn
 * later and it has already had a turn to carry on where the parent left off.
 */
export function ForkSessionDialog({
  request,
  takenTitles,
  botAnchor,
  onClose,
  onFork,
}: {
  /** What is being forked, or null when the dialog is closed. */
  request: ForkRequest | null;
  /** Every title already in the source's project, which is how the proposal picks its number. */
  takenTitles: readonly string[];
  /**
   * The anchor a fork onto a Bot starts under, previewed from the anchors every Bot holds. Present
   * when the fork is for a Bot: the field below is only the bracket task, and the sidecar spends
   * the real anchor at launch. Absent for a fork that belongs to nobody, which keeps counting
   * past its project's titles instead.
   */
  botAnchor?: string;
  onClose: () => void;
  onFork: (request: ForkRequest, title: string, brief: string, worktree: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The text this opening wants selected, until it has been. Null once it is, or when closed. */
  const wantsSelected = useRef<string | null>(null);

  useEffect(() => {
    if (!request) return;
    // A Bot fork starts under the anchor with whatever task is typed; anything else counts past
    // its project's titles the way it always has.
    const seed = botAnchor ? "" : nextForkTitle(request.session.title || request.session.sessionId, takenTitles);
    setTitle(seed);
    // Seeded with what that message said, because the thing a reader wants from forking at a
    // message is almost always to send it again differently -- which is what Claude's own rewind
    // does when it puts the rewound-to message back in the composer to be edited. Offering it here
    // means the editing happens before the fork exists rather than in its pane afterwards.
    setBrief(request.from?.text ?? "");
    setWorktree(false);
    setError(null);
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

  /**
   * Reads the brief in the PAGE, for the reason the Bot creator does: a grounding brief is usually
   * a file, and an API that opens a path on request is a file-read primitive reachable by anything
   * on the tailnet. The text crosses the wire; the path never does.
   */
  const loadBrief = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      if (text.length > MAXIMUM_BRIEF) {
        throw new Error(`${file.name} is longer than ${MAXIMUM_BRIEF} characters`);
      }
      setBrief(text);
      setError(null);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // A Bot fork with an empty task starts bare under its anchor; anything else needs a name.
    const chosen = title.trim();
    if (!botAnchor && !chosen) return;
    onFork(request, chosen, brief, worktree);
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
        {botAnchor ? (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-sm text-foreground">
            {botAnchor} <span className="text-muted-foreground">(what it is doing)</span>
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Branches <span className="font-medium text-foreground">{source}</span> into a new session
          in its own pane. The original is untouched.
        </p>
        {/* Which message, quoted, because a count is not something a reader can check. This is the
            same text the sidecar matches the rewind picker against, so what is shown here is what
            the fork will be asked to land on. */}
        {request.from ? (
          <p className="max-h-24 overflow-y-auto rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            It starts just before this message, which is yours to edit below:
            {" "}
            <span className="text-foreground">&ldquo;{request.from.text}&rdquo;</span>
          </p>
        ) : null}
        <label className="block text-sm font-medium">
          {botAnchor ? "Task" : "Name"}
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
          {botAnchor
            ? "Sets the bracket task; the anchor above never changes, here, in /resume, or for other agents."
            : "Sets the name everywhere at once — here, in /resume, and the one other agents message it by. Forks of one session share a name unless you give them their own."}
        </p>
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">
              First turn <span className="font-normal text-muted-foreground">optional</span>
            </span>
            <label className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-within:ring-2 focus-within:ring-primary">
              <Upload className="size-3.5" aria-hidden />
              Load a brief
              <input type="file" accept=".md,.txt,text/*" onChange={loadBrief} className="sr-only" />
            </label>
          </div>
          <textarea
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            maxLength={MAXIMUM_BRIEF}
            rows={5}
            placeholder="The sibling task this fork is for, as opposed to what the parent is finishing."
            className="mt-2 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {brief.trim()
              ? `${brief.length.toLocaleString()} characters, after a note telling the fork to leave the parent's work alone`
              : request.from
              ? "Left empty, the fork stops before that message with it still in its composer, for you to edit there."
              : "Left empty, the fork opens holding the parent's context and waits for you to type."}
          </p>
        </div>
        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 hover:bg-muted/40 focus-within:ring-2 focus-within:ring-primary active:bg-muted/70">
          <input
            type="checkbox"
            checked={worktree}
            onChange={(event) => setWorktree(event.target.checked)}
            className="mt-0.5"
          />
          <span className="text-sm">
            <span className="block font-medium">Give it its own tree and branch</span>
            {/* The cost is named, not just the benefit. Two agents in one checkout share an index
                and every uncommitted file, which is fine while they are doing the same thing and
                is not the moment they are not. */}
            <span className="block text-xs text-muted-foreground">
              A git worktree, on a branch named after the fork. Without it the fork edits the same
              files as the session it came from.
            </span>
          </span>
        </label>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
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
            disabled={!botAnchor && !title.trim()}
            className="flex min-h-10 min-w-24 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Fork
          </button>
        </div>
      </form>
    </dialog>
  );
}
