import { useState } from "react";
import { FileText, X } from "lucide-react";
import type { ComposerPaste } from "@agentdesk/agent-feed-wire";
import { modalWhileMounted } from "@/hooks/dom/refCallbacks";
import { sourceKey, usePanelQuery } from "@/query/panelQuery";

/**
 * The pastes a terminal composer is holding, above the field and beside the images.
 *
 * Claude does not put a long paste in its prompt box. It puts `[Pasted text #N]` there and keeps
 * the words in a table inside its own process, so the composer is holding an attachment rather
 * than editable text -- one backspace takes the whole thing. Drawn as a chip for exactly that
 * reason: the field holds what a reader can edit, and this is not that.
 *
 * Two kinds, and the difference is whether anyone on this side can still produce the words. The
 * sidecar remembers the text of every paste IT made, which is every push this field sent, so
 * those open. A paste made at that keyboard leaves a handle nothing here has the words of, and it
 * says so rather than opening on nothing -- "there is nothing in it" and "it is not ours to show"
 * are different facts and a reader deciding whether to send can only act on the second if it is
 * said.
 *
 * Nothing is revealed by hover, for the reason the image strip gives: half the readers of this
 * panel are on a phone, where a control that appears on hover is a control that is not there.
 */
export function ComposerPasteStrip({
  pastes,
  onPreview,
  onExpand,
  onRemove,
  disabled,
}: {
  pastes: readonly ComposerPaste[];
  onPreview: (token: string) => Promise<string | null>;
  onExpand: (token: string) => Promise<void>;
  onRemove: (token: string) => void;
  disabled: boolean;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const shown = pastes.find((paste) => paste.token === opened) ?? null;

  // A paste can leave the composer while its preview is open -- removed from the strip behind it,
  // or taken by a turn somebody submitted in the pane. Close rather than hold a window onto
  // something the composer is no longer carrying.
  if (opened !== null && shown === null) setOpened(null);

  if (pastes.length === 0) return null;

  return (
    <>
      <ul className="flex flex-wrap gap-3 px-3 pt-3">
        {pastes.map((paste) => (
          <li key={paste.token} className="relative">
            <PasteChip
              paste={paste}
              onOpen={paste.held === null ? null : () => setOpened(paste.token)}
            />
            <button
              type="button"
              onClick={() => onRemove(paste.token)}
              disabled={disabled}
              aria-label={`Remove pasted text #${paste.id} from the composer`}
              // Always drawn, never revealed, overlapping the corner so it costs the chip no room.
              className="absolute -right-2 -top-2 flex h-7 w-7 touch-manipulation items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm outline-none transition-colors hover:border-destructive hover:text-destructive focus-visible:ring-2 focus-visible:ring-primary active:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {shown ? (
        <PastePreview
          paste={shown}
          read={onPreview}
          onClose={() => setOpened(null)}
          onExpand={disabled ? null : () => {
            void onExpand(shown.token);
            setOpened(null);
          }}
          onRemove={disabled ? null : () => {
            onRemove(shown.token);
            setOpened(null);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * One paste, named by what it is rather than by its handle.
 *
 * The number is what Claude calls it and means nothing to a reader; the SIZE is what they need to
 * decide whether it is the thing they meant to attach. So the chip leads with the lines and
 * characters where the sidecar knows them, and falls back to the number where it does not,
 * because then the number is genuinely all there is.
 */
function PasteChip({ paste, onOpen }: { paste: ComposerPaste; onOpen: (() => void) | null }) {
  const shape = paste.held === null
    ? `#${paste.id}`
    : paste.held.lines > 1
      ? `${paste.held.lines} lines`
      : `${paste.held.chars} characters`;
  const body = (
    <>
      <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{shape}</span>
    </>
  );
  if (onOpen === null) {
    return (
      <span
        className="flex h-14 min-w-28 max-w-56 touch-manipulation items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground"
        title={`Pasted text #${paste.id}, pasted in the terminal. The words are inside Claude, so the panel cannot show them.`}
      >
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open pasted text #${paste.id}`}
      className="flex h-14 min-w-28 max-w-56 touch-manipulation items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground outline-none transition-[border-color,color,opacity] hover:border-primary hover:text-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary active:opacity-70"
    >
      {body}
    </button>
  );
}

/**
 * The words behind one handle, fetched when the reader opens it.
 *
 * A native `<dialog>` for the reason every other dialog in this panel is one: Escape and the
 * backdrop come with it, and it is the top layer rather than a z-index somebody has to keep
 * winning -- which matters here because the composer band sits inside a session card that scrolls.
 *
 * Read-only. Claude offers no way to change the inside of a handle, so an editable preview would
 * be a field whose edits could only be applied by removing the paste and sending the whole thing
 * again as a new one. Removing it is on the same dialog, which is that act said plainly.
 */
function PastePreview({
  paste,
  read,
  onClose,
  onExpand,
  onRemove,
}: {
  paste: ComposerPaste;
  read: (token: string) => Promise<string | null>;
  onClose: () => void;
  onExpand: (() => void) | null;
  onRemove: (() => void) | null;
}) {
  const words = usePanelQuery({
    queryKey: ["composer-paste", sourceKey(read), paste.token],
    queryFn: () => read(paste.token),
  });
  const text = words.data ?? null;
  const failed = words.isSuccess && words.data === null;

  return (
    <dialog
      ref={modalWhileMounted}
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      aria-label={`Pasted text #${paste.id}`}
      className="m-auto max-h-[85dvh] w-[min(46rem,92vw)] rounded-xl border border-border bg-card p-0 text-foreground backdrop:bg-black/60"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="truncate text-sm font-medium">
          {paste.held === null
            ? `Pasted text #${paste.id}`
            : `Pasted text #${paste.id} · ${paste.held.lines} lines, ${paste.held.chars} characters`}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="max-h-[60dvh] overflow-auto px-4 py-3">
        {text !== null ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) text-foreground">
            {text}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">
            {failed
              ? "Claude is holding these words inside the session, so the panel cannot show them."
              : "Reading…"}
          </p>
        )}
      </div>
      {onExpand || onRemove ? (
        <div className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row">
          {/* Only where the words are actually in hand. Offering it on a paste the sidecar is not
              holding would be a control that can do nothing, which is worse than no control. */}
          {onExpand && text !== null ? (
            <button
              type="button"
              onClick={onExpand}
              className="min-h-11 flex-1 touch-manipulation rounded-lg border border-border text-sm font-medium text-foreground outline-none transition-colors hover:border-primary focus-visible:ring-2 focus-visible:ring-primary active:bg-muted"
            >
              Put back in the field
            </button>
          ) : null}
          {onRemove ? (
            <button
              type="button"
              onClick={onRemove}
              className="min-h-11 flex-1 touch-manipulation rounded-lg border border-border text-sm font-medium text-muted-foreground outline-none transition-colors hover:border-destructive hover:text-destructive focus-visible:ring-2 focus-visible:ring-primary active:bg-muted"
            >
              Remove from the composer
            </button>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}
