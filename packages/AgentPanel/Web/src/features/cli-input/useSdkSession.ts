"use client";

// A Claude session run through the Agent SDK, as its composer sees it (ADR-0143).
//
// The runner in the session's pane holds everything that is waiting -- a question, an approval --
// and the sidecar streams its whole state. So this holds no copy of its own beyond the latest
// state, and a sidecar that restarted is current again with its first message: nothing the reader
// was looking at depended on the connection that went away.

import { useCallback, useMemo, useState } from "react";
import {
  DISCONNECTED_CLAUDE_SDK_STATE,
  type ClaudeEffortLevel,
  type ClaudePermissionMode,
  type ClaudeSdkCommandOutcome,
  type ClaudeSdkSessionState,
} from "@agentdesk/agent-feed-wire";
import type { SessionAddress, SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { TmuxQuestionSender } from "@/features/session-view/composer/question/useTmuxQuestion";
import { useStateFor } from "@/hooks/state/useStateFor";
import { useSubscription } from "@/hooks/useSubscription";
import { sourceKey } from "@/query/panelQuery";

type SdkFeed = Pick<
  SidecarDataSource,
  | "subscribeClaudeSdk"
  | "promptClaudeSdk"
  | "answerClaudeSdkQuestion"
  | "decideClaudeSdk"
  | "setClaudeSdkMode"
  | "setClaudeSdkModel"
  | "setClaudeSdkEffort"
  | "interruptClaudeSdk"
>;

/** A refusal, said the way the reader's situation reads. */
export function sdkRefusalText(outcome: Exclude<ClaudeSdkCommandOutcome, { ok: true }>): string {
  switch (outcome.reason) {
    case "no-runner":
      return "This session is not running, so there is nothing to send to.";
    case "not-pending":
      return "That request is no longer waiting.";
    case "invalid":
    case "failed":
      return outcome.message;
  }
}

export function useSdkSession(feed: SdkFeed, session: SessionAddress, active: boolean) {
  const { source, sessionId } = session;
  // Both start over whenever the session, or whether this is its input surface, changes.
  const scope = `${sourceKey(feed)}:${source}/${sessionId}:${active}`;
  const [state, setState] = useStateFor<ClaudeSdkSessionState>(scope, () => DISCONNECTED_CLAUDE_SDK_STATE);
  const [pending, setPending] = useState(false);
  const [error, setError] = useStateFor<string | null>(scope, () => null);

  useSubscription(active ? scope : null, () => feed.subscribeClaudeSdk({ source, sessionId }, setState));

  /** Runs one command, answering whether it happened; a refusal or a failure becomes `error`. */
  const run = useCallback(async (command: () => Promise<ClaudeSdkCommandOutcome>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      const outcome = await command();
      if (!outcome.ok) setError(sdkRefusalText(outcome));
      return outcome.ok;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setPending(false);
    }
  }, [setError]);

  const address = useMemo(() => ({ source, sessionId }), [source, sessionId]);
  const send = useCallback(
    (text: string, files?: Parameters<SdkFeed["promptClaudeSdk"]>[2]) => run(() => feed.promptClaudeSdk(address, text, files)),
    [address, feed, run],
  );
  const interrupt = useCallback(() => run(() => feed.interruptClaudeSdk(address)), [address, feed, run]);
  const decide = useCallback(
    (toolUseId: string, allow: boolean, message?: string) =>
      run(() => feed.decideClaudeSdk(address, { toolUseId, allow, ...(message ? { message } : {}) })),
    [address, feed, run],
  );
  /**
   * Switches the model, throwing a refusal rather than parking it in `error`: the picker that asks
   * keeps itself open and shows why, which is where the reader is looking.
   */
  const setModel = useCallback(async (model: string) => {
    const outcome = await feed.setClaudeSdkModel(address, model);
    if (!outcome.ok) throw new Error(sdkRefusalText(outcome));
  }, [address, feed]);
  /** Sets the effort, throwing a refusal for the picker to show, as `setModel` does. */
  const setEffort = useCallback(async (effort: ClaudeEffortLevel) => {
    const outcome = await feed.setClaudeSdkEffort(address, effort);
    if (!outcome.ok) throw new Error(sdkRefusalText(outcome));
  }, [address, feed]);
  /** Puts the session in one mode, which its runner sets directly; the new state arrives on the stream. */
  const choosePermissionMode = useCallback(
    (mode: ClaudePermissionMode) => run(() => feed.setClaudeSdkMode(address, mode)),
    [address, feed, run],
  );

  /**
   * Answers through the runner in the shape the terminal's dialog takes, so the question band drafts
   * and commits one way whichever kind of session it is. Nothing to point: there is no cursor.
   */
  const questions: TmuxQuestionSender = useMemo(() => ({
    answerTmuxQuestion: (target, answers) => feed.answerClaudeSdkQuestion(target, answers),
    pointTmuxQuestion: async () => ({ pointed: true }),
  }), [feed]);

  return { state, pending, error, send, interrupt, decide, choosePermissionMode, setModel, setEffort, questions };
}

export type SdkSessionHandle = ReturnType<typeof useSdkSession>;

/**
 * The runner's models as the shared picker takes them, or null while the list has not arrived. A
 * row is one model, keyed by what `setModel` takes; the `claude` provider is the arena's spelling.
 */
export function sdkModelRows(state: ClaudeSdkSessionState) {
  if (state.models.length === 0) return null;
  return state.models.map((entry) => ({
    providerID: "claude",
    modelID: entry.value,
    name: entry.displayName,
    contextLimit: null,
    inputCost: null,
    outputCost: null,
  }));
}

/** The row the session is answering with, matched by alias or by the full id an alias stands for. */
export function currentSdkModel(state: ClaudeSdkSessionState): ClaudeSdkSessionState["models"][number] | null {
  if (!state.model) return null;
  return state.models.find((entry) => entry.value === state.model)
    ?? state.models.find((entry) => entry.value !== "default" && entry.resolvedModel === state.model)
    ?? null;
}

/**
 * The effort row the models picker shows under the list: the current model's levels, or nothing
 * for a model without effort, or while the session's model is not yet matched to a row.
 */
export function sdkEffortChoice(session: Pick<SdkSessionHandle, "state" | "setEffort">) {
  const levels = currentSdkModel(session.state)?.effortLevels;
  if (!levels || levels.length === 0) return undefined;
  return {
    levels,
    current: session.state.effort,
    onChoose: (level: string) => session.setEffort(level as ClaudeEffortLevel),
  };
}
