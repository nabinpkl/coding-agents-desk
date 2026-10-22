// ask_owner: the questions a session is waiting on the owner to answer, and the answers back.
//
// Its own layer rather than more of `SidecarComposers`, whose question routes it sits beside,
// because that file is near its cap. Waiting is the sidecar's to report (`askOwner.ts` in the wire
// says why the transcript cannot), so this is a stream of what is waiting and two commands.

import type { AskOwnerAnswer, AskOwnerCall, AskOwnerOutcome, AskOwnerStreamMessage } from "@agentdesk/agent-feed-wire";
import { parse, type SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
import { SidecarComposers } from "@/features/activity-feed/data-source/layers/SidecarComposers";

function asksPath(session: SessionAddress, rest: string): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/asks${rest}`;
}

export class SidecarAsks extends SidecarComposers {
  /**
   * Every ask_owner call this session is waiting on, whole, now and on every change.
   *
   * Returns unsubscribe, and the caller must call it.
   */
  subscribeAsks(session: SessionAddress, onAsks: (asks: AskOwnerCall[]) => void): () => void {
    return this.transport.subscribe(asksPath(session, "/stream"), {
      onMessage: (payload) => onAsks((JSON.parse(payload) as AskOwnerStreamMessage).asks),
      // Silent, for the composer stream's reason: the panel already says when the sidecar has
      // stopped answering, and the stream reconnects on its own.
      onError: () => {},
    });
  }

  /** Hands the answers to the waiting call. What then waits arrives on the stream. */
  async answerAsk(
    session: SessionAddress,
    toolUseId: string,
    answers: readonly AskOwnerAnswer[],
  ): Promise<AskOwnerOutcome> {
    return parse<AskOwnerOutcome>(
      await this.transport.request("POST", asksPath(session, `/${encodeURIComponent(toolUseId)}/answer`), {
        body: { answers },
      }),
    );
  }

  /** Closes the call unanswered; the session is told the owner closed it. */
  async dismissAsk(session: SessionAddress, toolUseId: string): Promise<AskOwnerOutcome> {
    return parse<AskOwnerOutcome>(
      await this.transport.request("POST", asksPath(session, `/${encodeURIComponent(toolUseId)}/dismiss`)),
    );
  }
}
