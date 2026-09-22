import { Bot, EyeOff, LoaderCircle, Plus, ScanFace } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { SessionAvatar } from "@/features/bots/SessionAvatar";
import { BotFace, setBotFaces, useBotFaces } from "@/features/bots/avatar/BotFace";
import { botCanvasHues, botCanvasRanks, botSessionFaceRank, botSessionShades, botSessionStyle, botSurfaceStyle } from "@/features/bots/botSurface";
import { SessionRowMenu } from "@/features/bots/menus/SessionRowMenu";

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
 */
export function BotAvatar({ bot, hue, rank, size = "size-12" }: {
  bot: Pick<BotView, "name" | "iconUrl">;
  hue?: number;
  rank?: number;
  size?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [bot.iconUrl]);
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

function attachedSessionKey(session: BotSessionRef): string {
  return `${session.source}:${session.sessionId}`;
}

export function BotSidebarPanel({
  bots,
  loading,
  error,
  selectedBotIds,
  selectedSessionKeys,
  onSelectSession,
  onAddSession,
  onRenameSession,
  onDetachSession,
  onAddBot,
  machineLabels,
  status,
  canvas,
}: {
  bots: BotView[];
  /**
   * Which machine each Bot is on, by id, and EMPTY when there is only one machine to be on.
   *
   * This roster lists every Bot the panel can see, and since a Bot's directory can be on a remote
   * peer that is now more than one machine's worth. Saying so here matters more than on the canvas,
   * not less: a card is a wide thing with a path on it, while a row is a name and a folder, and two
   * peers with a `projects` directory each would otherwise be two identical rows.
   */
  machineLabels?: ReadonlyMap<string, string>;
  loading: boolean;
  error: string | null;
  /** Every Bot to mark. A set because the canvas opens as many cards as it is asked to. */
  selectedBotIds: ReadonlySet<string>;
  selectedSessionKeys: ReadonlySet<string>;
  onSelectSession: (bot: BotView, session: SessionSummary) => void;
  onAddSession: (bot: BotView) => void;
  /** Opens the rename dialog for one session. Claude only; a Codex row does not offer it. */
  onRenameSession: (session: SessionSummary) => void;
  /**
   * Drops the reference from the Bot's projection. The session itself is untouched.
   *
   * Takes a reference rather than a summary because the rows that most need this are the ones
   * with no summary left: a transcript the catalog has forgotten shows as "missing" and would
   * otherwise be the one entry a Bot can never be rid of.
   */
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  onAddBot: () => void;
  /**
   * Rendered between the Add Bot button and the roster.
   *
   * A slot rather than a prop of its own, because the two mounts have nothing to say to each
   * other: the Bots tab says nothing here, and the canvas says how many of these Bots are on it.
   */
  status?: ReactNode;
  /**
   * Which of these Bots are on the canvas, and how to change that. Absent in the Bots tab, which
   * is a view of the Bots themselves and has no canvas to be on.
   *
   * The set is the Bots that are OFF, the same one the canvas subtracts by, so this roster and the
   * cards cannot disagree about which is which.
   */
  canvas?: {
    detachedBotIds: ReadonlySet<string>;
    /**
     * The Bots with no card because their MACHINE is hidden, whether or not they are also
     * detached.
     *
     * Kept apart from `detachedBotIds` because they are two axes with two controls. A row here
     * dims the same way, since what a reader sees is one Bot with no card either way -- but its
     * avatar toggle is DISABLED rather than relabelled, because pressing it would move this Bot's
     * own membership and still leave the strip exactly as it was. The way back is the machine chip
     * above this roster, which is also where the count of what it is holding back is written.
     */
    machineHiddenBotIds: ReadonlySet<string>;
    /**
     * The sessions that are off the canvas, as `source:sessionId`.
     *
     * Their rows stay in this list and are dimmed, which is the whole point of taking one off: the
     * card goes, the session does not, and this is where it is found again. Clicking one is what
     * puts it back, the same click that opens any other row here.
     */
    detachedSessionKeys: ReadonlySet<string>;
    onToggle: (bot: BotView) => void;
  };
}) {
  /**
   * The same colours the canvas gives, derived here rather than passed in.
   *
   * Safe to derive twice because the derivation is a pure function of the roster, and this panel is
   * given the WHOLE roster -- it has to be, since it renders the Bots that are off the canvas too
   * and dims them. So the input is the same input the shell hands the canvas, and a Bot's face in
   * this list is the colour of its card by construction rather than by agreement.
   */
  const hues = useMemo(() => botCanvasHues(bots), [bots]);
  const ranks = useMemo(() => botCanvasRanks(bots), [bots]);
  const faces = useBotFaces();
  return (
    <div className="min-h-0">
      <div className="flex items-center border-b border-border">
        <button
          type="button"
          onClick={onAddBot}
          className="flex min-h-11 flex-1 cursor-pointer items-center gap-2 px-3 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-primary/15"
        >
          <Plus className="size-4" aria-hidden />
          Add Bot
        </button>
        {/* The one control for the faces switch, so both mounts of this roster move together: the
            store above is what carries the press to every avatar, including the canvas cards. Off
            until chosen -- the initials are what every reader knows, and the press is remembered
            the way the sidebar's own arrangement is. */}
        <button
          type="button"
          onClick={() => setBotFaces(!faces)}
          aria-pressed={faces}
          aria-label={faces ? "Show Bot initials instead of faces" : "Show Bot faces instead of initials"}
          title={faces ? "Showing faces" : "Showing initials"}
          className="mr-1 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary aria-pressed:text-primary text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted/80"
        >
          <ScanFace className="size-4" aria-hidden />
        </button>
      </div>
      {status}
      {loading ? (
        <div role="status" className="flex min-h-28 items-center justify-center gap-2 p-4 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          Loading Bots…
        </div>
      ) : error ? (
        <div role="alert" className="p-4 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
          Bots unavailable: {error}
        </div>
      ) : bots.length === 0 ? (
        <div role="status" className="flex min-h-28 flex-col items-center justify-center gap-2 p-4 text-center text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          <Bot className="size-5" aria-hidden />
          No bots yet
        </div>
      ) : (
        <ul role="list" aria-label="Bots">
          {bots.map((bot) => {
            const projectName = bot.environment.path.split("/").filter(Boolean).at(-1) ?? bot.environment.path;
            const hue = hues.get(bot.botId);
            const selected = selectedBotIds.has(bot.botId);
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
            const machineLabel = machineLabels?.get(bot.botId);
            // The same ladder the canvas cards stand on, derived here for the same reason the hues
            // are: it is a pure function of the Bot's own durable roster, so both surfaces reach
            // the same answer by construction rather than by agreement. A session that is one
            // shade of teal on its card and another in this list would be two facts to learn.
            const shades = botSessionShades(bot.sessionRefs);
            return (
              <li
                key={bot.botId}
                // A GAP between Bots, where this carried a hairline. Every row here is a filled
                // band in its own colour now, and a neutral line between two saturated blocks is
                // not a divider, it is a seam nobody sees. Space separates what colour cannot.
                className="mb-3 last:mb-0"
              >
                <div
                  // The same surface and rail its card wears on the canvas, so one Bot is one
                  // colour in both places -- the rule its sessions already follow, one level up.
                  //
                  // `border-l-2` where the card carries six. That ratio exists to say which way
                  // the nesting goes among cards on the strip, and there is no nesting to state
                  // here; six pixels in a sidebar a reader has dragged narrow is a bar arguing
                  // with the name beside it. The COLOUR is the half that has to match.
                  //
                  // Painted only while the Bot has a card, for the reason a session row is: the
                  // colour is what having a card looks like. Off the strip it goes neutral and
                  // dim under the same crossed eye. The dimming sits on this header rather than
                  // on the whole entry so it cannot reach the session rows below, which carry
                  // colours of their own and answer this question one at a time.
                  //
                  // The selected Bot no longer takes `bg-muted`. It is a utility, so it outranks
                  // the component layer this fill lives in and would repaint the row flat grey --
                  // exactly how an open session's row used to lose its colour.
                  className={`flex min-h-16 items-center gap-3 border-b border-b-border/70 border-l-2 py-2 pr-3 pl-1 ${
                    hue !== undefined && onStrip !== false
                      ? "bot-surface bot-rail"
                      : "border-transparent"
                  } ${onStrip === false ? "opacity-55" : ""}`}
                  style={hue === undefined || onStrip === false ? undefined : botSurfaceStyle(hue)}
                >
                  {canvas ? (
                    // The avatar IS the control. A control of its own would be a second 40px
                    // column in a sidebar the reader has usually dragged narrow, and the Bot's
                    // name is what loses those pixels.
                    //
                    // No badge on its corner: the row already says on or off through its colour
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
                      <BotAvatar bot={bot} hue={hue} rank={ranks.get(bot.botId)} />
                    </button>
                  ) : (
                    <BotAvatar bot={bot} hue={hue} rank={ranks.get(bot.botId)} />
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
                    // Children are INSET: the Bot runs the panel's full width and its sessions
                    // start sixteen pixels in, so parent-to-child is a step rather than a line.
                    // `gap-px` shows the ground between rows that would otherwise merge.
                    className="flex flex-col gap-px pt-1 pl-4"
                  >
                    {bot.sessions.map((session) => {
                      const key = attachedSessionKey(session);
                      const active = selected && selectedSessionKeys.has(key);
                      // No card for this session right now, by either route: the reader took the
                      // session off, or took the whole Bot off. One fact rather than two, because
                      // a row that looks identical to the ones with cards would make the canvas
                      // read as having lost one, and from here a reader cannot act on which of
                      // the two reasons it is.
                      const noCard = (canvas?.detachedSessionKeys.has(key) ?? false)
                        || onStrip === false;
                      const shaded = botSessionStyle(hue, shades.get(key));
                      // Its own face rather than its Bot's, so siblings never share one; either
                      // half missing leaves the mark on its disc.
                      const botRank = ranks.get(bot.botId);
                      const step = shades.get(key);
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
                          // The same fill and rail its card wears on the canvas, so one session is
                          // one colour wherever it is drawn -- and ONLY while it is drawn in both
                          // places. The colour is what a card looks like, so a row with no card
                          // gives it up and goes neutral and dim, which leaves the coloured rows
                          // reading as exactly the set standing on the strip.
                          //
                          // Whether that card is UNFOLDED is the face's to say rather than the
                          // fill's. It was the fill's once: an open session took `bg-muted`, a
                          // utility that outranks this layer, and the row a reader was most likely
                          // looking at went flat grey while its card kept the session's colour.
                          // `aria-current` carries it for a reader who sees neither.
                          className={`flex items-center border-l-2 pr-1.5 ${
                            shaded && !noCard ? "bot-session-edge bot-session-fill" : "border-transparent"
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
                              session.source === "claude"
                                ? () => onRenameSession(session)
                                : undefined
                            }
                            onDetach={() => onDetachSession(bot, session)}
                          />
                        </li>
                      );
                    })}
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
          })}
        </ul>
      )}
    </div>
  );
}
