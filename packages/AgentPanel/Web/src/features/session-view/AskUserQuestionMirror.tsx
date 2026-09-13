"use client";

// Claude's AskUserQuestion panel, mirrored: the hook that watches it and the surface that
// renders it. One file because the surface is the only reader of the hook, and the two
// have to agree about what a pre-selected option means.

import { useCallback, useEffect, useRef, useState } from "react";
import { List, LoaderCircle, X } from "lucide-react";
import {
  type QuestionPanelStatus,
  type WindowComposerClient,
  WindowQuestionError,
} from "../window-composer/WindowComposerClient";
import type { OpenAskUserQuestion } from "../../app/askUserQuestion";
import { composerReasonText } from "./SessionTerminalControls";

/**
 * The AskUserQuestion mirror's mechanism, mirroring the composer hook's shape.
 *
 * The watch is active while the FEED says a question is open, not focus-gated like the composer:
 * a question panel is a transient, modal surface that appears only while the model is waiting for
 * an answer, so the status poll exists only for that window, and the panel's pre-checked state
 * (Claude pre-selects options) must appear before any interaction. The mirror's CONTENT comes from
 * the transcript JSON via `question`; this hook only watches the live AX state and drives presses.
 *
 * The reconcile rule matches the composer: our own action results are always adopted (they are the
 * echo of a press that landed), while status updates respect an in-flight "Other" edit so a poll
 * arriving between keystrokes cannot clobber them.
 */
export function useClaudeWindowQuestion(
  host: WindowComposerClient,
  sessionId: string,
  active: boolean,
  question: OpenAskUserQuestion | null,
) {
  const [status, setStatus] = useState<QuestionPanelStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [otherText, setOtherText] = useState("");
  const [otherChecked, setOtherChecked] = useState(false);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const selectedRef = useRef<number[]>([]);
  const otherTextRef = useRef("");
  const otherEdited = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    otherTextRef.current = otherText;
  }, [otherText]);

  // A new question (new callId) starts a fresh mirror: no carried-over selection or
  // Other text from the previous question, and a fresh status read on the new watch.
  useEffect(() => {
    setStatus(null);
    setError(null);
    setSelected([]);
    setOtherText("");
    setOtherChecked(false);
    setOptionsExpanded(false);
    otherEdited.current = false;
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
  }, [question?.callId]);

  const reportFailure = useCallback((failure: unknown) => {
    setError(
      failure instanceof WindowQuestionError
        ? composerReasonText(failure.reason)
        : String((failure as Error).message ?? failure),
    );
  }, []);

  /** Adopts a status update, respecting an in-flight Other edit. */
  const adoptFromStatus = useCallback((next: QuestionPanelStatus) => {
    setStatus(next);
    if (next.present !== true) return;
    setSelected(next.selected);
    if (!otherEdited.current) {
      setOtherText(next.otherText ?? "");
      setOtherChecked((next.otherText?.length ?? 0) > 0);
    }
  }, []);

  /** Adopts our own action's post-action state unconditionally. */
  const adoptFromResult = useCallback((next: QuestionPanelStatus) => {
    setStatus(next);
    if (next.present !== true) return;
    setSelected(next.selected);
    otherEdited.current = false;
    setOtherText(next.otherText ?? "");
    setOtherChecked((next.otherText?.length ?? 0) > 0);
  }, []);

  const run = useCallback(
    async (operation: () => Promise<QuestionPanelStatus>) => {
      setPending(true);
      setError(null);
      try {
        adoptFromResult(await operation());
      } catch (failure) {
        reportFailure(failure);
      } finally {
        setPending(false);
      }
    },
    [adoptFromResult, reportFailure],
  );

  useEffect(() => {
    if (!active) return;
    return host.subscribeWindowQuestion(sessionId, adoptFromStatus);
  }, [active, adoptFromStatus, host, sessionId]);

  const selectOption = useCallback(
    (index: number) => {
      if (question?.multiSelect) {
        const desired = !selectedRef.current.includes(index);
        // Optimistic toggle; the host presses only on mismatch and the result reconciles.
        setSelected((current) =>
          desired ? [...current, index] : current.filter((entry) => entry !== index),
        );
        void run(() => host.selectQuestionOption(sessionId, index, desired));
      } else {
        setSelected([index]);
        void run(() => host.selectQuestionOption(sessionId, index, true));
      }
    },
    [host, question?.multiSelect, run, sessionId],
  );

  // The automatic push behind every Other keystroke, debounced like the composer's
  // sync. Deliberately silent: no spinner freezes the input mid-keystroke, and the
  // caption carries the reason when the window refused.
  const pushOther = useCallback(async () => {
    const sent = otherTextRef.current;
    try {
      const result = await host.setQuestionOther(sessionId, sent);
      // An edit during flight superseded this push; adopting the stale echo would
      // clobber the newer text. Keep the status, drop the stale text.
      if (otherTextRef.current === sent) {
        adoptFromResult(result);
      } else {
        setStatus(result);
      }
    } catch (failure) {
      reportFailure(failure);
    }
  }, [adoptFromResult, host, reportFailure, sessionId]);

  const changeOther = useCallback(
    (text: string) => {
      otherEdited.current = true;
      setOtherText(text);
      setOtherChecked(text.length > 0);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        void pushOther();
      }, 500);
    },
    [pushOther],
  );

  const toggleOther = useCallback(() => {
    if (otherChecked) {
      otherEdited.current = true;
      setOtherText("");
      setOtherChecked(false);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        void pushOther();
      }, 500);
    }
    // Turning Other on just means the user is about to type; the input takes focus.
  }, [otherChecked, pushOther]);

  const submit = useCallback(
    () => run(() => host.submitQuestion(sessionId)),
    [host, run, sessionId],
  );
  const skip = useCallback(
    () => run(() => host.skipQuestion(sessionId)),
    [host, run, sessionId],
  );
  const dismiss = useCallback(
    () => run(() => host.dismissQuestion(sessionId)),
    [host, run, sessionId],
  );
  const toggleOptions = useCallback(() => {
    setOptionsExpanded((current) => !current);
    void run(() => host.toggleQuestionOptions(sessionId));
  }, [host, run, sessionId]);

  // Mirror-composer discipline: only a KNOWN reason disables the controls; before
  // any status they stay usable so the watch (and its forced read) can start.
  const enabled = status?.enabled !== false;
  const canSubmit =
    question != null &&
    enabled &&
    (selected.length > 0 || otherText.trim().length > 0);
  const notice = status?.enabled === false ? composerReasonText(status.reason) : null;

  return {
    visible: question != null && status?.present !== false,
    question,
    optionsExpanded,
    selected,
    otherText,
    otherChecked,
    pending,
    enabled,
    error: error ?? notice,
    canSubmit,
    selectOption,
    changeOther,
    toggleOther,
    toggleOptions,
    submit,
    skip,
    dismiss,
  };
}

/**
 * The AskUserQuestion mirror: Claude's question panel, rendered from the transcript
 * JSON and actuated through the host's AX presses. Mirrors the real panel's controls
 * -- question, options, Other input, Skip, Submit -- plus its header's View options
 * and Dismiss affordances.
 */
export function AskUserQuestionMirror({
  question,
  optionsExpanded,
  selected,
  otherText,
  otherChecked,
  pending,
  disabled,
  error,
  onSelectOption,
  onChangeOther,
  onToggleOther,
  onToggleOptions,
  onSubmit,
  onSkip,
  onDismiss,
}: {
  question: OpenAskUserQuestion;
  optionsExpanded: boolean;
  selected: number[];
  otherText: string;
  otherChecked: boolean;
  pending: boolean;
  disabled: boolean;
  error: string | null;
  onSelectOption: (index: number) => void;
  onChangeOther: (text: string) => void;
  onToggleOther: () => void;
  onToggleOptions: () => void;
  onSubmit: () => void;
  onSkip: () => void;
  onDismiss: () => void;
}) {
  const inert = pending || disabled;
  return (
    <section
      aria-label="Claude question"
      className="mb-3 rounded-xl border border-border bg-background p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-(length:--agent-panel-fs-sidebar-body,15px) font-medium leading-6 text-foreground">
          {question.question}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onToggleOptions}
            disabled={inert}
            aria-label="View question options"
            aria-expanded={optionsExpanded}
            title={optionsExpanded ? "Collapse option descriptions" : "Expand option descriptions"}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <List className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onDismiss}
            disabled={inert}
            aria-label="Dismiss question"
            title="Dismiss the question without answering"
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>
      {question.header ? (
        <p className="mt-0.5 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          {question.header}
        </p>
      ) : null}
      <div className="mt-2 space-y-1">
        {question.options.map((option, index) => {
          const checked = selected.includes(index);
          const id = `ask-user-question-option-${index}`;
          return (
            <div
              key={index}
              className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50"
            >
              <input
                id={id}
                type={question.multiSelect ? "checkbox" : "radio"}
                name={question.multiSelect ? undefined : "ask-user-question"}
                checked={checked}
                disabled={inert}
                onChange={() => onSelectOption(index)}
                aria-label={option.label}
                className="mt-1 size-4 accent-primary"
              />
              <label
                htmlFor={id}
                className="min-w-0 flex-1 cursor-pointer text-(length:--agent-panel-fs-sidebar-body,15px) leading-6"
              >
                <span className="font-medium text-foreground">{option.label}</span>
                {optionsExpanded && option.description ? (
                  <span className="block whitespace-pre-wrap text-(length:--agent-panel-fs-sidebar-meta,13px) leading-5 text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </label>
            </div>
          );
        })}
        <div className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50">
          <input
            id="ask-user-question-other"
            type="checkbox"
            checked={otherChecked}
            disabled={inert}
            onChange={onToggleOther}
            aria-label="Other"
            className="mt-1 size-4 accent-primary"
          />
          <label
            htmlFor="ask-user-question-other"
            className="min-w-0 flex-1 cursor-pointer text-(length:--agent-panel-fs-sidebar-body,15px) font-medium leading-6 text-foreground"
          >
            Other
          </label>
          <input
            type="text"
            value={otherText}
            disabled={inert}
            onChange={(event) => onChangeOther(event.target.value)}
            placeholder="Type your own answer here"
            aria-label="Other answer"
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-(length:--agent-panel-fs-sidebar-body,15px) leading-6 outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/25 disabled:opacity-40"
          />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onSkip}
          disabled={inert}
          className="h-8 rounded-lg px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground hover:bg-muted disabled:opacity-40"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={inert || !(selected.length > 0 || otherText.trim().length > 0)}
          aria-label="Submit answer"
          className="flex h-8 items-center justify-center gap-1 rounded-lg bg-primary px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {pending ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
          Submit ⏎
        </button>
      </div>
      {error ? (
        <p aria-live="polite" className="px-1 pt-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
