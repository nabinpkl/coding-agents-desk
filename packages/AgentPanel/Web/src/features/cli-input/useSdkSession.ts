"use client";

// A Claude session run through the Agent SDK, as its composer sees it (ADR-0143).
//
// The runner in the session's pane holds everything that is waiting -- a question, an approval --
// and the sidecar streams its whole state. So this holds no copy of its own beyond the latest
// state, and a sidecar that restarted is current again with its first message: nothing the reader
// was looking at depended on the connection that went away.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DISCONNECTED_CLAUDE_SDK_STATE,
  type ClaudePermissionMode,
  type ClaudeSdkCommandOutcome,
  type ClaudeSdkSessionState,
} from "@agentdesk/agent-feed-wire";
import type { SessionAddress, SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { TmuxQuestionSender } from "@/features/session-view/composer/question/useTmuxQuestion";

type SdkFeed = Pick<
  SidecarDataSource,
  | "subscribeClaudeSdk"
  | "promptClaudeSdk"
  | "answerClaudeSdkQuestion"
  | "decideClaudeSdk"
  | "setClaudeSdkMode"
  | "interruptClaudeSdk"
>;

/**
 * The modes the mode chip steps through, in the order the terminal's Shift+Tab does, so a reader
 * moving between the two kinds of session meets one cycle. Bypass only where the launch allowed it.
 */
export function nextPermissionMode(current: ClaudePermissionMode | null, allowBypass: boolean): ClaudePermissionMode {
  const cycle: ClaudePermissionMode[] = ["auto", "acceptEdits", "plan", ...(allowBypass ? ["bypassPermissions" as const] : []), "manual"];
  const at = current === null ? -1 : cycle.indexOf(current);
  return cycle[(at + 1) % cycle.length]!;
}

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
  const [state, setState] = useState<ClaudeSdkSessionState>(DISCONNECTED_CLAUDE_SDK_STATE);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { source, sessionId } = session;

  useEffect(() => {
    setState(DISCONNECTED_CLAUDE_SDK_STATE);
    setError(null);
    if (!active) return undefined;
    return feed.subscribeClaudeSdk({ source, sessionId }, setState);
  }, [active, feed, source, sessionId]);

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
  }, []);

  const address = useMemo(() => ({ source, sessionId }), [source, sessionId]);
  const send = useCallback((text: string) => run(() => feed.promptClaudeSdk(address, text)), [address, feed, run]);
  const interrupt = useCallback(() => run(() => feed.interruptClaudeSdk(address)), [address, feed, run]);
  const decide = useCallback(
    (toolUseId: string, allow: boolean, message?: string) =>
      run(() => feed.decideClaudeSdk(address, { toolUseId, allow, ...(message ? { message } : {}) })),
    [address, feed, run],
  );
  const cycleMode = useCallback(
    () => run(() => feed.setClaudeSdkMode(address, nextPermissionMode(state.permissionMode, state.allowBypass))),
    [address, feed, run, state.allowBypass, state.permissionMode],
  );

  /**
   * Answers through the runner in the shape the terminal's dialog takes, so the question band drafts
   * and commits one way whichever kind of session it is. Nothing to point: there is no cursor.
   */
  const questions: TmuxQuestionSender = useMemo(() => ({
    answerTmuxQuestion: (target, answers) => feed.answerClaudeSdkQuestion(target, answers),
    pointTmuxQuestion: async () => ({ pointed: true }),
  }), [feed]);

  return { state, pending, error, send, interrupt, decide, cycleMode, questions };
}

export type SdkSessionHandle = ReturnType<typeof useSdkSession>;
