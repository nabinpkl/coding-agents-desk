import { ChevronRight, EyeOff, Plus } from "lucide-react";
import { useState } from "react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { SessionAvatar } from "@/features/bots/SessionAvatar";
import { BotAvatar } from "@/features/bots/avatar/BotAvatar";
import { attachedSessionKey, splitSessionsByCanvas } from "@/features/bots/botRosterOrder";
import { BOT_SESSION_SHADES, botSessionFaceRank, botSessionSlots, botSessionStyle, botSurfaceStyle } from "@/features/bots/botSurface";
import { canRenameSession } from "@/features/bots/sessionRename";
import { useMissingSessionLog } from "@/features/bots/useMissingSessionLog";
import { BotTerminalButton } from "@/features/bots/BotTerminalButton";
import { SessionRowMenu } from "@/features/bots/menus/SessionRowMenu";

/**
 * One Bot in the sidebar's roster: its header, its sessions, and what it does with the ones that
 * have no card.
 *
 * Its own component because the fold below it is STATE, and state belongs to one row rather than
 * to a map inside the panel. Everything derived from the whole roster -- the Bot's hue, its rank
 * on the face ladder, whether it is the selected one -- arrives as a prop for the same reason it
 * always did: those are answers about the roster, and a row is given one Bot.
 */
export function BotRosterRow({
  bot,
  hue,
  rank,
  selected,
  selectedSessionKeys,
  machineLabel,
  feed,
  canvas,
  onSelectSession,
  onAddSession,
  onRenameSession,
  onDetachSession,
}: {
  bot: BotView;
  /** The Bot's colour and its place on the face ladder, both ranked over the whole roster. */
  hue?: number;
  rank?: number;
  selected: boolean;
  selectedSessionKeys: ReadonlySet<string>;
  /** Which machine this Bot is on, absent when there is only one to be on. */
  machineLabel?: string;
  /**
   * The sidecar that owns this Bot's directory, for the header's terminal button. Absent when the
   * roster was rendered without a shell behind it, and the button with it.
   */
  feed?: SidecarDataSource;
  canvas?: {
    detachedBotIds: ReadonlySet<string>;
    machineHiddenBotIds: ReadonlySet<string>;
    detachedSessionKeys: ReadonlySet<string>;
    onToggle: (bot: BotView) => void;
  };
  onSelectSession: (bot: BotView, session: SessionSummary) => void;
  onAddSession: (bot: BotView) => void;
  onRenameSession: (session: SessionSummary) => void;
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
}) {
  // What the reader was shown, for the missing rows further down. The sidecar already says why a
  // reference went missing; this closes the chain by saying the row reached the screen, which is
  // the half that cannot be recovered from the sidecar's log after the fact. A Bot can be here and
  // on a canvas card at once, so this is a separate observation from that card's.
  useMissingSessionLog(bot, "roster-row");
  // Transient by the rule in AGENTS.md: a fold a reader opened to find one session is not an
  // arrangement they would have to rebuild, and one that survived a reload would quietly undo the
  // compaction on every Bot they had ever looked inside.
  const [showFolded, setShowFolded] = useState(false);
  const projectName = bot.environment.path.split("/").filter(Boolean).at(-1) ?? bot.environment.path;
  // Undefined when there is no canvas in the picture, which is not the same as being
  // off one. This used to dim the whole entry, sessions included; the avatar's badge
  // says it without spending opacity, and the dimming reached down into rows that now
  // carry a colour of their own and cannot afford to be washed out.
  //
  // Two ways to be off it, and the row states the one a reader can act on from here.
  // `onStrip` is the question the dimming and the badge answer -- is there a card for
  // this Bot right now -- so a Bot that is attached and invisible does not wear a tick
  // over a dimmed row, which is the contradiction that made this worth writing down.
  const machineHidden = canvas?.machineHiddenBotIds.has(bot.botId) ?? false;
  const onCanvas = canvas ? !canvas.detachedBotIds.has(bot.botId) : undefined;
  const onStrip = onCanvas === undefined ? undefined : onCanvas && !machineHidden;
  // The same ladder the canvas cards stand on, derived here for the same reason the hues
  // are: it is a pure function of the Bot's own stored slots, so both surfaces reach
  // the same answer by construction rather than by agreement. A session that is one
  // shade of teal on its card and another in this list would be two facts to learn.
  const slots = botSessionSlots(bot.sessionRefs, bot.sessionSlots);
  const split = splitSessionsByCanvas(
    bot.sessions,
    (session) => (canvas?.detachedSessionKeys.has(attachedSessionKey(session)) ?? false)
      || onStrip === false,
  );
  const sessionRow = (session: SessionSummary) => {
    const key = attachedSessionKey(session);
    const active = selected && selectedSessionKeys.has(key);
    // No card for this session right now, by either route: the reader took the
    // session off, or took the whole Bot off. One fact rather than two, because
    // a row that looks identical to the ones with cards would make the canvas
    // read as having lost one, and from here a reader cannot act on which of
    // the two reasons it is.
    const noCard = (canvas?.detachedSessionKeys.has(key) ?? false)
      || onStrip === false;
    const step = slots.get(key);
    const shaded = botSessionStyle(hue, step === undefined ? undefined : step % BOT_SESSION_SHADES);
    // Its own face rather than its Bot's, so siblings never share one; either
    // half missing leaves the mark on its disc.
    const botRank = rank;
    const faceRank = botRank !== undefined && step !== undefined
      ? botSessionFaceRank(botRank, step)
      : undefined;
    return (
      // The row was one button until it grew a second action. A button cannot
      // contain a button, so opening the session and opening its menu are now
      // siblings, and the row's selected tint moves up to the item that holds
      // both.
      <li
        key={key}
        // A bar where the child starts, one indent inside its Bot's, and the
        // only thing this row paints. `bot-rail`, so the Bot's hue and NOT this
        // session's: the rule beside `BOT_SESSION_HUE_SPACING` in
        // `botSurface.ts`, and the reason that constant can be as wide as it is.
        // Neighbouring sessions sit sixty degrees apart around the WHOLE circle,
        // so a rail on `--bot-session-hue` turns the one channel that answers
        // whose Bot this is into six unrelated colours. Measured before it was
        // believed. Which session is the face's to say, on that turned hue.
        //
        // Not `bot-session-edge`, the laddered border this row wore under a fill:
        // struck from `--bot-border` to ring one, on bare ground it measures
        // 1.58:1 at the first step and 3.34:1 at the sixth, so half a list would
        // have looked unbordered.
        //
        // Whether the card is UNFOLDED is the face's to say through its eyes,
        // and whether there is one at all is the dimming's and the crossed
        // eye's. `aria-current` carries the first for a reader who sees neither.
        className={`flex items-center border-l-2 pr-1.5 ${
          shaded && !noCard ? "bot-rail" : "border-transparent"
        } ${noCard ? "opacity-55" : ""}`}
        style={shaded}
      >
        <button
          type="button"
          onClick={() => onSelectSession(bot, session)}
          aria-current={active ? "page" : undefined}
          // `pl-2` where this was `pl-6`, which costs the title nothing: 8px of
          // padding plus the 32px mark and the 8px gap after it puts the text at
          // the same 48px the tightened layout starts at. The indent is now SPOKEN by the mark
          // rather than by empty space, which is what lets a narrow sidebar carry
          // one at all -- added to the old indent it would have taken 32px off
          // every title in the roster.
          className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pr-2 pl-2 text-left text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80"
        >
          {/* The same mark the canvas card draws, and the only place this list
              says whether a session is live at all: the row had no activity on
              it before, so the ring is information the sidebar was missing
              rather than a restatement of something beside it. */}
          <SessionAvatar
            title={session.title || session.sessionId}
            activity={session.activity}
            shaded={Boolean(shaded) && !noCard}
            rank={faceRank}
            shut={!active}
          />
          {/* `font-medium`, matching the same session's title on its canvas card.
              One object drawn at two weights in two places is drift, not
              density: the reader learns the treatment in one surface and it
              does not hold in the other. Medium is the item-title weight here,
              a step under the Bot name's semibold above it. */}
          <span className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium">
            {session.title || session.sessionId}
          </span>
          {/* Says this session has no card right now, in words the dimming
              cannot: dim alone reads as disabled. The crossed eye the row menu
              already spends on "Remove from canvas", so the mark and the control
              that sets it say one thing. */}
          {noCard ? (
            <span
              role="img"
              aria-label="Off the canvas"
              title="Off the canvas"
              className="flex shrink-0 items-center session-muted-ink"
            >
              <EyeOff className="size-3.5" aria-hidden />
            </span>
          ) : null}
          <SourceBadge source={session.source} />
        </button>
        <SessionRowMenu
          label={session.title || session.sessionId}
          onRename={
            canRenameSession(session) ? () => onRenameSession(session) : undefined
          }
          onDetach={() => onDetachSession(bot, session)}
        />
      </li>
    );
  };
  return (
    <li
      // The OUTER rail, running the height of the header and every session under it,
      // which is what makes them one entry. Nothing here has a background: structure is
      // rails, an indent and a hairline, and colour at fill strength is the canvas's.
      //
      // Every row here was a filled band until recently, each session in its own step of
      // the Bot's colour, the same fills its cards wear on the canvas -- a column of
      // saturated bands beside the thing they index, and the two competed. A card is a
      // wide object a reader looks AT; a roster row is a name they look THROUGH, so the
      // roster gives way. A bar down the leading edge says which Bot without taking the
      // ground from under the text, and each session repeats it one indent in, in the
      // same hue, so the nesting is two bars rather than two fills.
      //
      // `border-l-2` where the card carries six: that ratio says which way the nesting
      // goes among cards, and six pixels here argues with the name beside it. Painted
      // only while the Bot has a card, so off the strip the rail goes with it
      // and the header dims under the crossed eye. The dimming stays here so it cannot
      // reach the session rows, which answer that one at a time.
      className={`mb-3 border-l-2 pl-1 last:mb-0 ${
        hue !== undefined && onStrip !== false ? "bot-rail" : "border-transparent"
      }`}
      style={hue === undefined || onStrip === false ? undefined : botSurfaceStyle(hue)}
    >
      <div
        // No surface. The header wore its card's tint for one commit on the argument
        // that a whisper distinguishes a parent band from a list of children; the
        // sidebar does not want a background colour at all, at any strength, so the
        // hairline and the rails carry the structure and nothing here is painted.
        className={`flex min-h-16 items-center gap-3 border-b border-b-border/70 py-2 pr-3 ${
          onStrip === false ? "opacity-55" : ""
        }`}
      >
        {canvas ? (
          // The avatar IS the control. A control of its own would be a second 40px
          // column in a sidebar the reader has usually dragged narrow, and the Bot's
          // name is what loses those pixels.
          //
          // No badge on its corner: the entry already says on or off through its rail
          // and dimming, and the same toggle is on every card's own menu, which is
          // where a reader meets it first.
          <button
            type="button"
            onClick={() => canvas.onToggle(bot)}
            // Disabled rather than relabelled while the machine is hidden: this control
            // owns one axis, and on this row the other one is what is holding the card
            // back. A press that moved the state it owns and changed nothing on screen
            // is the worst of the three options.
            disabled={machineHidden}
            aria-pressed={onStrip}
            aria-label={machineHidden
              ? `${bot.name} is on ${machineLabel ?? "a machine"}, which is hidden from the canvas`
              : onCanvas ? `Take ${bot.name} off the canvas` : `Put ${bot.name} on the canvas`}
            title={machineHidden
              ? `${machineLabel ?? "This machine"} is hidden from the canvas. Show it above to bring ${bot.name} back.`
              : onCanvas ? "On the canvas" : "Off the canvas"}
            // The ring on hover is what says this face is a control. Without it nothing
            // else on the row admits that clicking here does anything.
            className="shrink-0 cursor-pointer rounded-full outline-none ring-primary/60 ring-offset-2 ring-offset-card transition-shadow hover:ring-2 focus-visible:ring-2 focus-visible:ring-primary active:ring-primary disabled:cursor-default disabled:hover:ring-0"
          >
            <BotAvatar bot={bot} hue={hue} rank={rank} />
          </button>
        ) : (
          <BotAvatar bot={bot} hue={hue} rank={rank} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-(length:--agent-panel-fs-sidebar-body,15px) font-semibold text-foreground">
            {bot.name}
          </span>
          {bot.metadata.role ? (
            // Caption tier, with the line below it. A role is a caption about the name
            // above it, and at 13px it was the same size as the session titles a few
            // rows down -- the one thing the canvas card was just fixed for. It reads
            // differently here only because this surface gives the role its own line
            // where the card concatenates it into one caption, which is why moving that
            // card's line left this one behind.
            <span className="block truncate text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
              {bot.metadata.role}
            </span>
          ) : null}
          <span className="mt-0.5 block truncate font-mono text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
            {machineLabel
              ? (
                <span className="not-italic font-sans font-medium">
                  {machineLabel}
                  {/* Said in text as well as in the tooltip, because the tooltip needs a
                      pointer and half the readers of this panel are on a phone. */}
                  {machineHidden ? " hidden" : ""}
                  {" · "}
                </span>
              )
              : null}
            {projectName}
            {bot.environmentAvailability === "missing" ? " · missing directory" : ""}
          </span>
        </span>
        {/* Same mark its sessions wear, and for the same reason: the row has given up
            its colour, and dim on its own reads as disabled rather than as off the
            canvas. The avatar's badge states the same fact as a CONTROL, which is what
            a reader presses; this is what a reader reads. */}
        {onStrip === false ? (
          <span
            role="img"
            aria-label="Off the canvas"
            title="Off the canvas"
            className="flex shrink-0 items-center text-muted-foreground"
          >
            <EyeOff className="size-4" aria-hidden />
          </span>
        ) : null}
        {feed ? <BotTerminalButton bot={bot} feed={feed} /> : null}
        <button
          type="button"
          onClick={() => onAddSession(bot)}
          disabled={bot.environmentAvailability === "missing"}
          aria-label={`Add sessions to ${bot.name}`}
          title={bot.environmentAvailability === "missing" ? "Bot directory is unavailable" : "Add sessions"}
          className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-background/70 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </div>

      {bot.sessions.length > 0 || bot.missingSessionRefs.length > 0 ? (
        <ul
          role="list"
          aria-label={`${bot.name} sessions`}
          // Children are INSET: sessions start sixteen pixels in from the rail, so
          // parent-to-child is a step. Flush rather than gapped now that the rows are
          // the panel's ground: a pixel of ground between two grounds separates nothing.
          className="flex flex-col pt-1 pl-4"
        >
          {split.withCard.map(sessionRow)}
          {/* Where the sunk rows would start. A Bot the reader took off the canvas has every
              session off it, so without this its row spends a screen of dimmed entries on the one
              Bot they just said they were done with -- and the count is the thing they cannot see
              once the rows are gone, which is why it is in the label rather than in a tooltip. */}
          {split.folded ? (
            <li className="flex items-center border-l-2 border-transparent">
              <button
                type="button"
                onClick={() => setShowFolded((shown) => !shown)}
                aria-expanded={showFolded}
                className="flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm py-1 pr-2 pl-2 text-left text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80"
              >
                {/* The same 32px column a session's face stands in, so the label starts where the
                    titles above it do rather than half an indent to their left. */}
                <span className="flex size-8 shrink-0 items-center justify-center">
                  <ChevronRight
                    className={`size-4 transition-transform ${showFolded ? "rotate-90" : ""}`}
                    aria-hidden
                  />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {showFolded ? "Hide" : "Show"} {split.withoutCard.length} off the canvas
                </span>
              </button>
            </li>
          ) : null}
          {split.folded && !showFolded ? null : split.withoutCard.map(sessionRow)}
          {bot.missingSessionRefs.map((ref) => (
            // Tokenised rather than `text-xs`, which is a size the reader's font settings
            // cannot reach: the control would move every row in this list except the
            // broken one. Chip tier, the same as the canvas draws a missing reference.
            <li key={attachedSessionKey(ref)} className="flex min-h-9 items-center gap-2 py-1 pr-1.5 pl-12 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">{ref.sessionId}</span>
              <SourceBadge source={ref.source} />
              <span>missing</span>
              <SessionRowMenu
                label={ref.sessionId}
                onDetach={() => onDetachSession(bot, ref)}
              />
            </li>
          ))}
        </ul>
      ) : (
        // Same size the canvas card says this in, and reachable from the font settings.
        <p className="pb-2 pr-3 pl-12 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">No sessions attached</p>
      )}
    </li>
  );
}
