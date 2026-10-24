// A chat before it exists: the box a scratch chat will open in, holding only its first message.
//
// Nothing is made until that message is sent -- no folder, no session, no request -- so closing
// the box unsent leaves nothing anywhere. Sending asks the sidecar to make the chat's folder and
// start it; the box the session then opens in is the same size and place as this one, so the
// reader sees the chat begin where they typed rather than one box closing and another opening.
//
// Beside `NewSessionDialog` because it is the same act with every choice made for the reader: no
// folder, no harness, no name to pick. The one choice left is which machine, and only where there
// is more than one: the panel's own unless another is picked in the header.

import { ArrowUp, LoaderCircle, X } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { machineKey, type BotMachine } from "@/features/bots/botMachines";
import { useMountEffect } from "@/hooks/useMountEffect";

export function ChatDraftDialog({
  machines,
  machine: shellMachine,
  onClose,
  onStart,
}: {
  /** Every machine a chat can start on. More than one puts a choice in the header. */
  machines: readonly BotMachine[];
  /** The machine the panel is pointed at, which the chat starts on unless another is picked. */
  machine: BotMachine;
  onClose: () => void;
  /** Starts the chat on `machine` and closes this box, or throws for the reason to show here. */
  onStart: (prompt: string, machine: BotMachine) => Promise<void>;
}) {
  const titleId = useId();
  const machineLabel = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [machine, setMachine] = useState(shellMachine);
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Focus goes to the message on open and back to whatever held it on close.
  useMountEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    field.current?.focus();
    return () => previous?.focus();
  });

  const close = () => {
    if (!pending) onClose();
  };

  const send = async () => {
    if (pending || !prompt.trim()) return;
    setPending(true);
    setError(null);
    try {
      await onStart(prompt, machine);
    } catch (reason) {
      // The message stays in the field, so a retry is one keystroke.
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-2 sm:p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-[min(100%,56rem)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl"
      >
        <header className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border py-1 pr-1 pl-4">
          <h2
            id={titleId}
            className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold"
          >
            New chat
          </h2>
          {machines.length > 1 ? (
            <div role="group" aria-labelledby={machineLabel} className="flex shrink-0 items-center gap-1">
              <span id={machineLabel} className="sr-only">
                Machine
              </span>
              {machines.map((candidate) => {
                const selected = candidate.feed === machine.feed;
                return (
                  <button
                    key={machineKey(candidate)}
                    type="button"
                    aria-pressed={selected}
                    disabled={pending}
                    onClick={() => {
                      setMachine(candidate);
                      field.current?.focus();
                    }}
                    className={`min-h-8 cursor-pointer rounded-full border px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${
                      selected
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80"
                    }`}
                  >
                    {candidate.label}
                  </button>
                );
              })}
            </div>
          ) : null}
          <button
            type="button"
            onClick={close}
            disabled={pending}
            aria-label="Close new chat"
            title="Close"
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <section className="flex min-h-0 flex-1 flex-col justify-end bg-background" aria-label="New chat">
          {/* The width the session view gives its message box, so the field stays put on send. */}
          {error ? (
            <p
              role="alert"
              className="mx-auto w-full max-w-[45rem] px-4 pb-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive"
            >
              {error}
            </p>
          ) : null}
          <div className="shrink-0 border-t border-border p-2">
            <div className="mx-auto flex w-full max-w-[45rem] items-end gap-1 rounded-xl border session-view-field shadow-xs transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
              <textarea
                ref={field}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={onKeyDown}
                disabled={pending}
                rows={3}
                maxLength={32_768}
                placeholder="Message"
                aria-label="First message"
                className="block max-h-60 min-h-12 min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-(length:--agent-panel-fs-sidebar-body,15px) leading-6 outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={pending || !prompt.trim()}
                aria-busy={pending || undefined}
                aria-label={pending ? "Starting chat" : "Send"}
                title="Send"
                className="m-1.5 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-primary text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? (
                  <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
                ) : (
                  <ArrowUp className="size-4" aria-hidden />
                )}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
