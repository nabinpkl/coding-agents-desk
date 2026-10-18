"use client";

// The AskUserQuestion mirror's window half: watching the panel in a session's Claude Desktop
// window and pressing it through the host's accessibility calls.
//
// Split out of the surface when the surface grew to render every question in a call. The two no
// longer have to agree about anything but the draft shape, and this one deliberately did not grow
// with it: the Desktop panel shows one question at a time and nothing here has measured what it
// does with a call carrying several, so it answers the FIRST and the band says so. The tmux half
// next door answers all of them, because its dialog was measured.

import { useCallback, useRef, useState } from "react";
import {
  type QuestionPanelStatus,
  type WindowComposerClient,
  WindowQuestionError,
} from "@/features/window-composer/WindowComposerClient";
import type { AskUserQuestionItem, OpenAskUserQuestion } from "@/app/askUserQuestion";
import { composerReasonText } from "@/features/session-view/SessionTerminalControls";
import { useStateFor } from "@/hooks/state/useStateFor";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useLeaveEffect } from "@/hooks/useMountEffect";
import { useSubscription } from "@/hooks/useSubscription";
import { sourceKey } from "@/query/panelQuery";

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
export function useWindowQuestion(
  host: WindowComposerClient,
  sessionId: string,
  active: boolean,
  question: OpenAskUserQuestion | null,
) {
  // The Desktop panel is single-pane, so this half only ever acts on the first question of a call.
  const asked: AskUserQuestionItem | null = question?.questions[0] ?? null;
  // A new question (new callId) starts a fresh mirror: no carried-over selection or
  // Other text from the previous question, and a fresh status read on the new watch.
  const callId = question?.callId;
  const [status, setStatus] = useStateFor<QuestionPanelStatus | null>(callId, () => null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useStateFor<string | null>(callId, () => null);
  const [selected, setSelected] = useStateFor<number[]>(callId, () => []);
  const [otherText, setOtherText] = useStateFor(callId, () => "");
  const selectedRef = useLatestRef(selected);
  const otherTextRef = useLatestRef(otherText);
  const otherEdited = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLeaveEffect(callId, () => {
    otherEdited.current = false;
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
  });

  const reportFailure = useCallback((failure: unknown) => {
    setError(
      failure instanceof WindowQuestionError
        ? composerReasonText(failure.reason)
        : String((failure as Error).message ?? failure),
    );
  }, [setError]);

  /** Adopts a status update, respecting an in-flight Other edit. */
  const adoptFromStatus = useCallback((next: QuestionPanelStatus) => {
    setStatus(next);
    if (next.present !== true) return;
    setSelected(next.selected);
    if (!otherEdited.current) {
      setOtherText(next.otherText ?? "");
    }
  }, [setStatus, setSelected, setOtherText]);

  /** Adopts our own action's post-action state unconditionally. */
  const adoptFromResult = useCallback((next: QuestionPanelStatus) => {
    setStatus(next);
    if (next.present !== true) return;
    setSelected(next.selected);
    otherEdited.current = false;
    setOtherText(next.otherText ?? "");
  }, [setStatus, setSelected, setOtherText]);

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
    [adoptFromResult, reportFailure, setError],
  );

  const adopt = useLatestRef(adoptFromStatus);
  useSubscription(active ? `${sourceKey(host)}:${sessionId}` : null, () =>
    host.subscribeWindowQuestion(sessionId, (next) => adopt.current(next)));

  const selectOption = useCallback(
    (index: number) => {
      if (asked?.multiSelect) {
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
    [host, asked?.multiSelect, run, sessionId, selectedRef, setSelected],
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
  }, [adoptFromResult, host, reportFailure, sessionId, otherTextRef, setStatus]);

  const changeOther = useCallback(
    (text: string) => {
      otherEdited.current = true;
      setOtherText(text);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        void pushOther();
      }, 500);
    },
    [pushOther, setOtherText],
  );

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
  // `toggleQuestionOptions` is deliberately not called any more. The panel used to mirror the
  // Desktop panel's own expand control; it now draws every description and preview at once, so
  // there is nothing here for that press to keep in step with. The host still offers it.
  // Mirror-composer discipline: only a KNOWN reason disables the controls; before
  // any status they stay usable so the watch (and its forced read) can start.
  const enabled = status?.enabled !== false;
  const canSubmit =
    asked != null &&
    enabled &&
    (selected.length > 0 || otherText.trim().length > 0);
  const notice = status?.enabled === false ? composerReasonText(status.reason) : null;

  return {
    /**
     * Whether this half owns the question, which needs the host to AFFIRM a panel.
     *
     * `present === true` rather than the optimistic `!== false` it used to be, and the change is
     * the point: this was once the only half, so claiming a question before the first status let
     * the mirror appear immediately and cost nothing. There is another half now -- the reader's
     * own draft, drawn from the tool call and answerable wherever the session is running -- and an
     * optimistic claim here would take every question from it and give it back a moment later.
     */
    visible: asked != null && status?.present === true,
    question: asked,
    /** How many questions this call carries that this half cannot reach. */
    unreachable: Math.max(0, (question?.questions.length ?? 0) - 1),
    selected,
    otherText,
    pending,
    enabled,
    error: error ?? notice,
    canSubmit,
    selectOption,
    changeOther,
    submit,
    skip,
    dismiss,
  };
}
