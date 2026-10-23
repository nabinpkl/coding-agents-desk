// Passing one lane's answer to a lane on the other side: a button per lane of the other stance, in
// the head of the lane whose answer it sends. A for lane's answer goes to an against lane to
// critique; an against lane's critique goes to a for lane to weigh (ADR-0152).
//
// Offered only in a run with lanes on both sides. Disabled, with the reason as its title, while any
// lane is still on its turn (the sidecar waits for the run to settle, as it does for a prompt) and
// before this lane has an answer to send.

import { useState } from "react";
import { Forward } from "lucide-react";
import type { ArenaContestantDetail } from "@agentdesk/agent-feed-wire";
import { BUTTON, isLive, TEXT } from "@/features/arena/arenaVocabulary";

export function ArenaPassButtons({
  contestant,
  lanes,
  onPass,
}: {
  /** The lane whose answer a button sends. */
  contestant: ArenaContestantDetail;
  /** Every lane of the run, this one among them. */
  lanes: readonly ArenaContestantDetail[];
  /** Sends the pass; resolves once the sidecar has answered, whichever way. */
  onPass: (from: string, to: string) => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  const others = lanes.filter((lane) => lane.stance !== contestant.stance);
  if (others.length === 0) return null;
  const why = lanes.some(isLive)
    ? "Waits for every lane to settle"
    : contestant.answer === null
      ? `${contestant.contestantId} has no answer to pass yet`
      : null;
  return others.map((to) => (
    <button
      key={to.contestantId}
      type="button"
      disabled={why !== null || sending}
      aria-label={`Pass ${contestant.contestantId}'s answer to ${to.contestantId}`}
      title={
        why ??
        `Send ${contestant.contestantId}'s latest answer to ${to.contestantId} ${to.stance === "against" ? "to critique" : "to weigh"}`
      }
      onClick={async () => {
        setSending(true);
        await onPass(contestant.contestantId, to.contestantId);
        setSending(false);
      }}
      className={`${BUTTON} min-h-8 gap-1 px-2 ${TEXT.meta}`}
    >
      <Forward aria-hidden className="size-3.5" />
      Pass to {to.contestantId}
    </button>
  ));
}
