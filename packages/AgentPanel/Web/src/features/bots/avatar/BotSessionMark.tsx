import type { Bin } from "@agentdesk/agent-feed-wire";
import type { BotSessionFace } from "@/features/bots/avatar/botSessionFaces";
import { SessionAvatar } from "@/features/bots/SessionAvatar";

/**
 * A Bot's session's face, drawn outside its Bot's roster and card: in the Canvas Sessions view's
 * rows and in the session modal's header.
 *
 * The Bot's hue and the session's step are set on this wrapper rather than on anything around it,
 * so they reach the face and stop there: text beside it that reads `session-muted-ink` would
 * otherwise take the card's ladder.
 */
export function BotSessionMark({
  title,
  activity,
  face,
  className = "",
}: {
  title: string;
  activity: Bin;
  face: BotSessionFace;
  className?: string;
}) {
  return (
    <span className={`shrink-0 ${className}`} style={face.style}>
      <SessionAvatar
        title={title}
        activity={activity}
        shaded={face.style !== undefined}
        rank={face.rank}
        shut={!face.open}
      />
    </span>
  );
}
