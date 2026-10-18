import { LoaderCircle } from "lucide-react";
import { useRef, type SubmitEvent } from "react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import { useModal } from "@/hooks/dom/overlays";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useStateFor } from "@/hooks/state/useStateFor";

/**
 * Renaming one Bot and restyling its face, in the smallest dialog that can carry the fields.
 *
 * App-level rather than inside the card that opened it, for `SessionRenameDialog`'s reason:
 * the same menu is rendered by the sidebar roster and by the canvas, and a dialog per row
 * would be two of them. Seeded from the record, so a rename is an edit of what is there;
 * emptied icon and role clear their fields the way the creator dialog reads a deleted field.
 */
export function BotRenameDialog({
  bot,
  onClose,
  onRename,
}: {
  /** The Bot being renamed, or null when the dialog is closed. */
  bot: BotView | null;
  onClose: () => void;
  onRename: (bot: BotView, restyle: { name: string; iconUrl?: string; role?: string }) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [name, setName] = useStateFor(bot, () => bot?.name ?? "");
  const [iconUrl, setIconUrl] = useStateFor(bot, () => bot?.iconUrl ?? "");
  const [role, setRole] = useStateFor(bot, () => bot?.metadata.role ?? "");
  const [pending, setPending] = useStateFor(bot, () => false);
  const [error, setError] = useStateFor<string | null>(bot, () => null);


  useModal(dialogRef, Boolean(bot), { attributeFallback: true });

  useDomSync(() => {
    if (bot) globalThis.requestAnimationFrame?.(() => field.current?.select());
  }, [bot]);

  if (!bot) return null;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (pending || !name.trim()) return;
    setPending(true);
    setError(null);
    try {
      await onRename(bot, {
        name: name.trim(),
        iconUrl: iconUrl.trim(),
        role: role.trim(),
      });
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
      setPending(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="bot-rename-title"
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
        <h2 id="bot-rename-title" className="text-base font-semibold">Rename Bot</h2>
        <label className="block text-sm font-medium">
          Name
          <input
            ref={field}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={64}
            className="mt-1 min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
        </label>
        <label className="block text-sm font-medium">
          Icon URL <span className="font-normal text-muted-foreground">optional, https; empty clears</span>
          <input
            type="url"
            value={iconUrl}
            onChange={(event) => setIconUrl(event.target.value)}
            placeholder="https://…"
            className="mt-1 min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
        </label>
        <label className="block text-sm font-medium">
          Role <span className="font-normal text-muted-foreground">optional; empty clears</span>
          <input
            value={role}
            onChange={(event) => setRole(event.target.value)}
            maxLength={120}
            className="mt-1 min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Renames it on this machine, so the new name shows on the canvas, in the roster, and
          anywhere else this Bot is read. Sessions keep their names; only the Bot is renamed.
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
            disabled={!name.trim() || pending}
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
