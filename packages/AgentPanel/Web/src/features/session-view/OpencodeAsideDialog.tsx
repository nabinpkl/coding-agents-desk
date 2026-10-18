// The `/btw` answer, over the composer the way the model picker is.
//
// One dialog for both halves of the command: the question is typed here when the draft carried
// none, and the answer lands in the same box when it did. The TUI asks the same way -- its
// `session.aside` prompts for the question when the slash arrives with no argument -- and the
// answer is transient by design, so it is shown here rather than appended anywhere: this
// question deliberately does not join the conversation.

import { useRef } from "react";
import { LoaderCircle, X } from "lucide-react";
import type { OpencodeAside } from "@/features/session-view/usePanelCommands";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useStateFor } from "@/hooks/state/useStateFor";

export function OpencodeAsideDialog({
  aside,
  onAsk,
  onClose,
}: {
  aside: OpencodeAside;
  onAsk: (question: string) => void;
  onClose: () => void;
}) {
  // Both follow the aside whenever it moves on.
  const asked = JSON.stringify([aside.question, aside.answer]);
  const [question, setQuestion] = useStateFor(asked, () => aside.question);
  const field = useRef<HTMLTextAreaElement | null>(null);
  // The answer to the question asked: a second ask arrives with no answer, so the first one does
  // not stay on screen beside the new question while it loads.
  const answered = aside.answer;
  useDomSync(() => {
    if (!aside.question) field.current?.focus();
  }, [aside.question, aside.answer]);

  return (
    <>
      <div aria-hidden className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Ask a side question"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !aside.pending) onClose();
        }}
        className="absolute bottom-full left-0 z-50 mb-2 flex max-h-96 w-[min(32rem,calc(100vw-2rem))] flex-col gap-2 overflow-hidden rounded-xl border border-border bg-card p-3 text-foreground shadow-2xl"
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Aside · not added to the conversation
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={aside.pending}
            aria-label="Close the side question"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onAsk(question);
          }}
          className="flex items-end gap-2"
        >
          <textarea
            ref={field}
            value={question}
            rows={2}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onAsk(question);
              }
            }}
            placeholder="Ask anything about this conversation…"
            aria-label="Your side question"
            className="min-h-16 min-w-0 flex-1 resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <button
            type="submit"
            disabled={aside.pending || question.trim().length === 0}
            className="h-9 shrink-0 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {aside.pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : "Ask"}
          </button>
        </form>
        {aside.error ? (
          <p role="alert" className="text-sm text-destructive">
            {aside.error}
          </p>
        ) : null}
        {aside.pending ? (
          <p className="text-sm text-muted-foreground">Reading the session&rsquo;s context&hellip;</p>
        ) : answered !== null ? (
          // Plain text, not markdown: the answer is transient and short, and a renderer here
          // would be the panel's only markdown surface asked to hold a model answer.
          <p className="min-h-0 flex-1 overflow-y-auto overscroll-contain whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {answered.trim().length > 0 ? answered : "(the session had nothing to add)"}
          </p>
        ) : null}
      </div>
    </>
  );
}
