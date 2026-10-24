// The question every delete asks before it acts (taste:frontend-design, "Every delete asks first").
//
// One dialog for every control that ends in a delete route, so each says the same things the same
// way: the thing by its name, what goes with it and what stays, a confirm button that repeats the
// act, and Cancel where a reflexive Enter lands. It is the page's own <dialog>, not
// `window.confirm`, which blocks the page and any automation driving it, and cannot say what stays.
//
// It stays open while the delete runs and shows a failure in place: it closes only when its owner
// stops rendering it open, which the owner does once the delete has succeeded.

import { useRef } from "react";
import type { ReactNode } from "react";
import { LoaderCircle, Trash2 } from "lucide-react";
import { useModal } from "@/hooks/dom/overlays";

export function ConfirmDeleteDialog({
  open,
  title,
  children,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** The question, naming the thing: "Delete arena run 3?" */
  title: string;
  /** What goes with it and what stays, in a sentence or two. */
  children: ReactNode;
  /** The act, repeated on the button: "Delete run". */
  confirmLabel: string;
  /** The delete is under way: neither button can be pressed again, and the dialog cannot close. */
  busy: boolean;
  /** Why the last attempt failed, in the sidecar's words; null before one has. */
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useModal(dialogRef, open, { attributeFallback: true });
  if (!open) return null;
  const cancel = () => {
    if (!busy) onCancel();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="confirm-delete-title"
      aria-describedby="confirm-delete-body"
      className="fixed inset-0 z-60 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-4 text-foreground backdrop:bg-black/45 open:flex"
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <section className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-border bg-card p-5 text-foreground shadow-2xl">
        <h2 id="confirm-delete-title" className="m-0 text-base font-semibold">
          {title}
        </h2>
        <div id="confirm-delete-body" className="text-sm leading-relaxed">
          {children}
        </div>
        {error ? (
          <p role="alert" className="m-0 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {/* Cancel first: the dialog's first control is where focus lands when it opens. */}
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="min-h-10 rounded-lg border border-border px-4 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy || undefined}
            className="flex min-h-10 min-w-28 items-center justify-center gap-2 rounded-lg bg-destructive px-4 text-sm font-semibold text-destructive-foreground outline-none transition-colors hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 active:bg-destructive/80 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="size-4" aria-hidden />
            )}
            {confirmLabel}
          </button>
        </div>
      </section>
    </dialog>
  );
}
