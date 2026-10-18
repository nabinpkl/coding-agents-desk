import type { BotView } from "@agentdesk/agent-feed-wire";
import { BotFace } from "@/features/bots/avatar/BotFace";
import { useBotFaces } from "@/features/bots/avatar/botFacesSwitch";
import { botSurfaceStyle } from "@/features/bots/botSurface";
import { useStateFor } from "@/hooks/state/useStateFor";

/**
 * A Bot's face: its picture, its generated face, or its initials on its own colour.
 *
 * The hue is the same one its card wears on the canvas, which is the whole reason it is here --
 * a colour that named a Bot in one surface and not in the other would be two facts to learn
 * instead of one. It arrives as a number rather than being derived from the Bot, because the
 * derivation ranks a Bot against the whole roster and this component is only ever given one.
 * The rank arrives beside it for the same reason, and is what draws the face: same ordering, so
 * the face agrees with the colour without either knowing about the other.
 *
 * Absent, the avatar is the neutral disc it has always been. That is the right answer, not a
 * fallback, wherever there is no roster to rank against: the Bot creator's live preview is of a
 * Bot that does not exist yet, and a colour there would be a promise about which one it will get.
 * An unranked Bot keeps its initials when faces are on for the same reason: no rank, no face.
 *
 * Beside `BotFace` rather than in the sidebar roster it used to live in, because four surfaces
 * draw it -- the roster, a canvas card, the session picker and the Bot creator's live preview --
 * and the one that happened to declare it was not its owner. What it renders is a face, which is
 * what this directory is for.
 */
export function BotAvatar({ bot, hue, rank, size = "size-12" }: {
  bot: Pick<BotView, "name" | "iconUrl">;
  hue?: number;
  rank?: number;
  size?: string;
}) {
  // A new picture gets its own chance to load.
  const [failed, setFailed] = useStateFor(bot.iconUrl, () => false);
  const faces = useBotFaces();
  const initials = bot.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "B";
  if (bot.iconUrl && !failed) {
    // An uploaded picture is the identity; painting a ring of our own around it would be a second
    // opinion about who this is.
    return (
      <img
        src={bot.iconUrl}
        alt=""
        className={`${size} shrink-0 rounded-full border border-border object-cover`}
        onError={() => setFailed(true)}
      />
    );
  }
  if (faces && rank !== undefined) {
    // The face IS the avatar, not a picture inside one. It stands alone rather than in the
    // initials' disc: a circle behind it would ring every head in the same shape the faces were
    // drawn to replace, and the head's own outline is the identity. The hue still crosses on a
    // style, because the face's CSS reads it for the head's colour and the eyes' sockets.
    return <BotFace rank={rank} className={`${size} shrink-0`} style={botSurfaceStyle(hue)} />;
  }
  return (
    <span
      aria-hidden
      // The border goes when the fill arrives. It was there to give `bg-muted` an edge -- a disc
      // 1.09:1 against the light panel ground, which is to say almost none -- and a tinted fill at
      // 1.48:1 is its own edge. Keeping both would ring a coloured disc in grey.
      className={`${size} flex shrink-0 items-center justify-center rounded-full font-semibold text-foreground ${
        hue === undefined ? "border border-border bg-muted" : "bot-accent"
      }`}
      style={botSurfaceStyle(hue)}
    >
      {initials}
    </span>
  );
}
