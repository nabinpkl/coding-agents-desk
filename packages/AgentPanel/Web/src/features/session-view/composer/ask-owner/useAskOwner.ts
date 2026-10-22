"use client";

// The ask_owner call a session is waiting on, the reader's answers to it, and the way to send them.
//
// What is waiting comes from the sidecar's stream and nothing else: the transcript says a call is
// finished two minutes in, when Claude Code moves it to the background, and that is not an answer.
// The oldest call is the one shown; any after it wait their turn.

import { useState } from "react";
import type { AskOwnerCall } from "@agentdesk/agent-feed-wire";
import type { SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
import type { SidecarAsks } from "@/features/activity-feed/data-source/layers/SidecarAsks";
import { useSubscription } from "@/hooks/useSubscription";
import { useStateFor } from "@/hooks/state/useStateFor";
import { runWithFinally } from "@/hooks/state/runWithFinally";
import { sourceKey } from "@/query/panelQuery";
import {
  chooseOption,
  emptyDrafts,
  isAnswered,
  toAnswers,
  writeNote,
  writeText,
  type AskOwnerDraft,
} from "@/features/session-view/composer/ask-owner/askOwnerDrafts";

/** The three calls this hook makes of the sidecar. */
export type AskOwnerSender = Pick<SidecarAsks, "subscribeAsks" | "answerAsk" | "dismissAsk">;

/** What the band draws an ask_owner call from, and hands the reader's answers back through. */
export interface AskOwnerModel {
  call: AskOwnerCall;
  drafts: readonly AskOwnerDraft[];
  answered: readonly boolean[];
  pending: boolean;
  error: string | null;
  canSubmit: boolean;
  choose: (at: number, option: number) => void;
  writeNote: (at: number, option: number, note: string) => void;
  writeText: (at: number, text: string) => void;
  submit: () => void;
  dismiss: () => void;
}

export function useAskOwner(feed: AskOwnerSender, session: SessionAddress, enabled: boolean): AskOwnerModel | null {
  const [asks, setAsks] = useState<readonly AskOwnerCall[]>([]);
  // Calls this reader has already delivered, hidden until the stream says they have gone, so a
  // sent card does not stand there waiting for the round trip.
  const [delivered, setDelivered] = useState<ReadonlySet<string>>(() => new Set());
  useSubscription(enabled ? `${sourceKey(feed)}:${session.source}:${session.sessionId}` : null, () =>
    feed.subscribeAsks(session, (next) => {
      setAsks(next);
      setDelivered((sent) => new Set([...sent].filter((id) => next.some((ask) => ask.toolUseId === id))));
    }),
  );
  // Matched on the session too, because the list is kept across a change of session until the new
  // stream speaks, and a card must never draw another session's question.
  const call = enabled
    ? (asks.find(
        (ask) => ask.source === session.source && ask.sessionId === session.sessionId && !delivered.has(ask.toolUseId),
      ) ?? null)
    : null;
  const callId = call?.toolUseId ?? null;
  const [drafts, setDrafts] = useStateFor<AskOwnerDraft[]>(callId, () => (call ? emptyDrafts(call.questions) : []));
  const [pending, setPending] = useStateFor(callId, () => false);
  const [error, setError] = useStateFor<string | null>(callId, () => null);
  if (!call) return null;

  const send = async (act: () => ReturnType<AskOwnerSender["answerAsk"]>) => {
    setPending(true);
    setError(null);
    await runWithFinally(
      async () => {
        try {
          const outcome = await act();
          if (outcome.delivered) setDelivered((sent) => new Set(sent).add(call.toolUseId));
          else setError(outcome.message);
        } catch (failure) {
          // The drafts stay as they are, so nothing the reader wrote is lost to a failed send.
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      },
      () => setPending(false),
    );
  };
  const answers = toAnswers(call.questions, drafts);
  return {
    call,
    drafts,
    answered: drafts.map(isAnswered),
    pending,
    error,
    canSubmit: answers !== null,
    choose: (at, option) => setDrafts((current) => chooseOption(current, at, option, call.questions[at]!)),
    writeNote: (at, option, note) => setDrafts((current) => writeNote(current, at, option, note)),
    writeText: (at, text) => setDrafts((current) => writeText(current, at, text, call.questions[at]!)),
    submit: () => {
      if (answers) void send(() => feed.answerAsk(session, call.toolUseId, answers));
    },
    dismiss: () => void send(() => feed.dismissAsk(session, call.toolUseId)),
  };
}
