"use client";

// One question of an ask_owner call: what it asks, its options with a note under each one chosen,
// and the words a reader can answer with instead of, or beside, an option.
//
// Drawn like Claude's own questions (`QuestionSection`) so the two read as one kind of thing; what
// is different is only what this tool adds: notes, and questions answered in words alone.

import { useRef } from "react";
import type { AskOwnerQuestion } from "@agentdesk/agent-feed-wire";
import type { AskOwnerDraft } from "@/features/session-view/composer/ask-owner/askOwnerDrafts";

const BODY = "text-(length:--agent-panel-fs-sidebar-body,15px) leading-6";
const META = "text-(length:--agent-panel-fs-sidebar-meta,13px)";
const FIELD = `min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 ${BODY} outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/25 disabled:opacity-40`;

export function AskOwnerSection({
  question,
  draft,
  showHeader,
  inert,
  onChoose,
  onWriteNote,
  onWriteText,
}: {
  question: AskOwnerQuestion;
  draft: AskOwnerDraft;
  showHeader: boolean;
  inert: boolean;
  onChoose: (option: number) => void;
  onWriteNote: (option: number, note: string) => void;
  onWriteText: (text: string) => void;
}) {
  const name = `ask-owner-${question.id}`;
  const multi = question.kind === "multi";
  // The header only while no tab strip names it, in the words Claude's own questions use.
  const subtitle =
    showHeader && question.header ? `${question.header}${multi ? " · choose any" : ""}` : multi ? "Choose any" : null;
  return (
    <div className="pt-1">
      <p className={`${BODY} font-medium text-foreground`}>{question.question}</p>
      {subtitle ? <p className={`mt-0.5 ${META} text-muted-foreground`}>{subtitle}</p> : null}
      {question.kind === "text" ? (
        <textarea
          value={draft.text}
          disabled={inert}
          rows={3}
          onChange={(event) => onWriteText(event.target.value)}
          placeholder={question.placeholder ?? "Your answer"}
          aria-label={`Your answer to: ${question.question}`}
          className={`mt-2 block w-full resize-y ${FIELD}`}
        />
      ) : (
        <div className="mt-2 space-y-1">
          {question.options.map((option, index) => {
            const id = `${name}-${index}`;
            const chosen = draft.chosen.includes(index);
            return (
              <div key={index} className="rounded-lg px-2 py-1.5 hover:bg-muted/50">
                <div className="flex items-start gap-2">
                  <input
                    id={id}
                    type={multi ? "checkbox" : "radio"}
                    name={multi ? undefined : name}
                    checked={chosen}
                    disabled={inert}
                    onChange={() => onChoose(index)}
                    aria-label={option.label}
                    className="mt-1 size-4 accent-primary"
                  />
                  <label htmlFor={id} className={`min-w-0 flex-1 cursor-pointer ${BODY}`}>
                    <span className="font-medium text-foreground">{option.label}</span>
                    {option.description ? (
                      <span className={`block ${META} leading-5 text-muted-foreground`}>{option.description}</span>
                    ) : null}
                    {/* Preformatted and scrollable: a preview is a small diagram, and reflowing it
                        would take away the thing it was drawn to show. */}
                    {option.preview ? (
                      <pre
                        className={`mt-1 max-w-full overflow-x-auto rounded-lg bg-muted/60 px-2 py-1 ${META} leading-5 text-muted-foreground`}
                      >
                        {option.preview}
                      </pre>
                    ) : null}
                  </label>
                </div>
                {/* Under the option it is about, and only once it is chosen: a note on an option
                    nobody picked would be sent nowhere. */}
                {chosen ? (
                  <div className="mt-1 flex pl-6">
                    <input
                      type="text"
                      value={draft.notes[index] ?? ""}
                      disabled={inert}
                      onChange={(event) => onWriteNote(index, event.target.value)}
                      placeholder={option.noteLabel ?? "Add a note"}
                      aria-label={`Note on ${option.label}`}
                      className={FIELD}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
          <SomethingElse
            name={name}
            question={question}
            draft={draft}
            inert={inert}
            onChoose={onChoose}
            onWriteText={onWriteText}
          />
        </div>
      )}
    </div>
  );
}

/** The row for an answer the options did not offer. */
function SomethingElse({
  name,
  question,
  draft,
  inert,
  onChoose,
  onWriteText,
}: {
  name: string;
  question: AskOwnerQuestion;
  draft: AskOwnerDraft;
  inert: boolean;
  onChoose: (option: number) => void;
  onWriteText: (text: string) => void;
}) {
  const multi = question.kind === "multi";
  const typed = draft.text.trim().length > 0;
  const field = useRef<HTMLInputElement | null>(null);
  // Picking the row is a move to it, not a value: on a single question it lets go of the option
  // chosen, and it puts the cursor in the field. Picking it while it holds words means "not this".
  const pick = () => {
    if (typed) {
      onWriteText("");
      return;
    }
    if (!multi && draft.chosen[0] !== undefined) onChoose(draft.chosen[0]);
    field.current?.focus();
  };
  return (
    <div className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50">
      <input
        type={multi ? "checkbox" : "radio"}
        name={multi ? undefined : name}
        checked={typed}
        disabled={inert}
        onChange={pick}
        aria-label="Something else"
        className="mt-1 size-4 accent-primary"
      />
      <input
        ref={field}
        type="text"
        value={draft.text}
        disabled={inert}
        onChange={(event) => onWriteText(event.target.value)}
        placeholder="Something else"
        aria-label={`Your own answer to: ${question.question}`}
        className={FIELD}
      />
    </div>
  );
}
