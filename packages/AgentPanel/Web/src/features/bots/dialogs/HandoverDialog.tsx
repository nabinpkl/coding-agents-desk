import { LoaderCircle } from "lucide-react";
import { useRef, type SubmitEvent } from "react";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import { handoverDestination, HANDOVER_LABELS } from "@/features/bots/sessionHandover";
import { useModal } from "@/hooks/dom/overlays";
import { useStateFor } from "@/hooks/state/useStateFor";

/**
 * What is being handed over, and where the reader was when they asked.
 *
 * The Bot travels along because the new opencode session lands on it: a handover asked for from
 * a card opens a card, and a session nobody owns has no card to open. The project path is the
 * directory the source runs in, which is where the new session is created.
 */
export interface HandoverRequest {
  botId: string;
  session: SessionSummary;
  projectPath: string;
}

/**
 * Confirming a handover to opencode, with room for one message of your own.
 *
 * App-level for `SessionRenameDialog`'s reason: the menu renders on the sidebar and on the
 * canvas, and the canvas one sits inside a card that scrolls sideways. The message is optional
 * and rides last in the prompt the new session receives, after the handed-over context -- an
 * instruction first would be buried under sixty kilobytes of history.
 */
export function HandoverDialog({
  request,
  onClose,
  onHandover,
}: {
  /** What is being handed over, or null when the dialog is closed. */
  request: HandoverRequest | null;
  onClose: () => void;
  onHandover: (request: HandoverRequest, message: string) => Promise<void>;
}) {
  const destination = request ? handoverDestination(request.session) : null;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useStateFor(request, () => "");
  const [pending, setPending] = useStateFor(request, () => false);
  const [error, setError] = useStateFor<string | null>(request, () => null);

  useModal(dialogRef, Boolean(request), { attributeFallback: true });

  if (!request || !destination) return null;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onHandover(request, message.trim());
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
      setPending(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="session-handover-title"
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
        <h2 id="session-handover-title" className="text-base font-semibold">
          Hand over to {HANDOVER_LABELS[destination]}
        </h2>
        <p className="text-sm text-muted-foreground">
          Starts {destination === "claude" ? "a" : "an"} {HANDOVER_LABELS[destination]} session on this Bot carrying{" "}
          <span className="font-mono">{request.session.title || request.session.sessionId}</span>
          &rsquo;s conversation, from its newest compaction if it has one. The new session opens on this Bot.
        </p>
        <label className="block text-sm font-medium">
          Message to send with it (optional)
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={3}
            placeholder="What should it do first?"
            className="mt-1 min-h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
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
            disabled={pending}
            className="flex min-h-10 min-w-24 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
            {pending ? "Starting…" : "Hand over"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
