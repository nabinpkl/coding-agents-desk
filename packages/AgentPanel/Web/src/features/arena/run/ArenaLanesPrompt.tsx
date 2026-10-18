// The prompt box in a run's header: the first prompt every lane gets, or the next one.

import { useId, useState, type KeyboardEvent } from "react";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { FIELD, FOCUS, PRIMARY_BUTTON, TEXT } from "@/features/arena/arenaVocabulary";

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SEND_CHORD = MAC ? "⌘↵" : "Ctrl↵";

/**
 * A prompt for every lane: the first, typed once the lanes are open, or the next, once the last
 * one has settled in every lane.
 *
 * The first is the view's one action, so it is a full box with a filled button. The next shares
 * the header with the lanes the reader is watching, so it is one quiet row that grows with what is
 * typed, its send button inside it the way every session composer has one, filled only once there
 * is something to send. It can be drafted while the lanes work, and sent once they settle.
 */
export function LanesPrompt({
  onSend,
  next,
  busy,
}: {
  onSend: (prompt: string) => Promise<string | null>;
  /** The prompt after the first: one row, and cleared once sent. */
  next: boolean;
  /** The lanes are still on the last prompt, so this one waits. */
  busy: boolean;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const canSend = !sending && !busy && text.trim().length > 0;
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setRefusal(null);
    const problem = await onSend(text);
    setSending(false);
    if (problem) setRefusal(problem);
    else if (next) setText("");
  };
  const sendOnChord = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };
  const refusalLine = refusal ? (
    <p role="alert" className={`${TEXT.meta} text-destructive`}>
      {refusal}
    </p>
  ) : null;
  if (next) {
    return (
      <div className="flex max-w-3xl flex-col gap-1.5">
        {/* The border is the row's, around the field and its button side by side, the way a
            session composer draws one: the button sits in the box without lying over the text. */}
        <div className="flex items-end gap-2 rounded-md border border-input bg-background py-1.5 pr-1.5 pl-3 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50">
          <textarea
            aria-label="Next prompt for every lane"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={sendOnChord}
            placeholder={
              busy ? "Draft the next prompt; it sends once every lane settles" : "Next prompt for every lane"
            }
            rows={1}
            className={`block max-h-40 min-h-7 flex-1 resize-none bg-transparent py-0.5 ${TEXT.body} leading-relaxed text-foreground outline-none field-sizing-content placeholder:text-muted-foreground`}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            aria-label="Send to every lane"
            title={
              busy
                ? "The lanes are still on the last prompt; send this once they settle"
                : `Send to every lane (${SEND_CHORD})`
            }
            className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors duration-150 hover:bg-primary/90 active:bg-primary/80 disabled:pointer-events-none disabled:bg-muted disabled:text-muted-foreground ${FOCUS}`}
          >
            {sending ? (
              <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <ArrowUp aria-hidden className="size-4" />
            )}
          </button>
        </div>
        {refusalLine}
      </div>
    );
  }
  return (
    <div className="flex max-w-3xl flex-col gap-2">
      <label htmlFor={id} className={`${TEXT.meta} font-medium text-muted-foreground`}>
        Prompt
      </label>
      <textarea
        id={id}
        aria-label="Prompt every lane gets"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={sendOnChord}
        placeholder="The one prompt every lane gets"
        rows={3}
        autoFocus
        className={`${FIELD} min-h-20 resize-y leading-relaxed`}
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {refusal ? (
          <p role="alert" className={`mr-auto ${TEXT.meta} text-destructive`}>
            {refusal}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          className={`${PRIMARY_BUTTON} whitespace-nowrap`}
        >
          {sending ? "Sending" : "Send to every lane"}
          <kbd className="rounded border border-primary-foreground/30 px-1 font-sans text-[11px] leading-4 opacity-80">
            {SEND_CHORD}
          </kbd>
        </button>
      </div>
    </div>
  );
}
