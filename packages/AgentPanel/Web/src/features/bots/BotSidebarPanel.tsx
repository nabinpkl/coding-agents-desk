import { Bot, Check, LoaderCircle, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SourceBadge } from "../sidebar/SourceBadge";
import { botCanvasHues, botSurfaceStyle } from "./botSurface";
import { SessionRowMenu } from "./SessionRowMenu";

/**
 * A Bot's face: its picture, or its initials on its own colour.
 *
 * The hue is the same one its card wears on the canvas, which is the whole reason it is here --
 * a colour that named a Bot in one surface and not in the other would be two facts to learn
 * instead of one. It arrives as a number rather than being derived from the Bot, because the
 * derivation ranks a Bot against the whole roster and this component is only ever given one.
 *
 * Absent, the avatar is the neutral disc it has always been. That is the right answer, not a
 * fallback, wherever there is no roster to rank against: the Bot creator's live preview is of a
 * Bot that does not exist yet, and a colour there would be a promise about which one it will get.
 */
export function BotAvatar({ bot, hue, size = "size-10" }: {
  bot: Pick<BotView, "name" | "iconUrl">;
  hue?: number;
  size?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [bot.iconUrl]);
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
  status,
  canvas,
}: {
  bots: BotView[];
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
  return (
    <div className="min-h-0">
      <button
        type="button"
        onClick={onAddBot}
        className="flex min-h-11 w-full cursor-pointer items-center gap-2 border-b border-border px-3 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-primary/15"
      >
        <Plus className="size-4" aria-hidden />
        Add Bot
      </button>
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
            // Off the canvas dims the whole entry, sessions included, because the thing that is
            // not on the canvas is the Bot rather than its header. Undefined when there is no
            // canvas in the picture, which is not the same as being off one.
            const onCanvas = canvas ? !canvas.detachedBotIds.has(bot.botId) : undefined;
            return (
              <li
                key={bot.botId}
                className={`border-b border-border/80 ${onCanvas === false ? "opacity-55" : ""}`}
              >
                <div className={`flex min-h-16 items-center gap-3 border-l-2 px-3 py-2 ${selected ? "border-primary bg-muted" : "border-transparent"}`}>
                  {canvas ? (
                    // The avatar IS the control, and the badge on its corner is what it says. A
                    // control of its own would be a second 40px column in a sidebar the reader has
                    // usually dragged narrow, and the Bot's name is what loses those pixels.
                    //
                    // The trade is discoverability: a face does not look like a checkbox, so the
                    // cursor, the tooltip and the badge itself have to carry that. Acceptable
                    // because the same toggle is on every card's own menu, which is where a reader
                    // meets it first.
                    <button
                      type="button"
                      onClick={() => canvas.onToggle(bot)}
                      aria-pressed={onCanvas}
                      aria-label={onCanvas ? `Take ${bot.name} off the canvas` : `Put ${bot.name} on the canvas`}
                      title={onCanvas ? "On the canvas" : "Off the canvas"}
                      // The ring on hover is what says this face is a control. Without it the
                      // badge reads as decoration on a picture, and nothing else on the row admits
                      // that clicking here does anything.
                      className="relative shrink-0 cursor-pointer rounded-full outline-none ring-primary/60 ring-offset-2 ring-offset-card transition-shadow hover:ring-2 focus-visible:ring-2 focus-visible:ring-primary active:ring-primary"
                    >
                      <BotAvatar bot={bot} hue={hue} />
                      {/* Ringed in the row's own background so it reads as sitting ON the avatar
                          rather than being part of the picture. */}
                      <span
                        aria-hidden
                        className={`absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full ring-2 ring-card ${
                          onCanvas
                            ? "bg-primary text-primary-foreground"
                            : "border border-muted-foreground/60 bg-card"
                        }`}
                      >
                        {onCanvas ? <Check className="size-2.5" strokeWidth={3} /> : null}
                      </span>
                    </button>
                  ) : (
                    <BotAvatar bot={bot} hue={hue} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-(length:--agent-panel-fs-sidebar-body,15px) font-semibold text-foreground">
                      {bot.name}
                    </span>
                    {bot.metadata.role ? (
                      <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
                        {bot.metadata.role}
                      </span>
                    ) : null}
                    <span className="mt-0.5 block truncate font-mono text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
                      {projectName}
                      {bot.environmentAvailability === "missing" ? " · missing directory" : ""}
                    </span>
                  </span>
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
                  <ul role="list" aria-label={`${bot.name} sessions`} className="pb-1">
                    {bot.sessions.map((session) => {
                      const key = attachedSessionKey(session);
                      const active = selected && selectedSessionKeys.has(key);
                      // Dimmed the way a Bot that is off the canvas is, and for the same reason:
                      // a row that looks identical to the ones with cards would make the canvas
                      // look as though it had lost one.
                      const offCanvas = canvas?.detachedSessionKeys.has(key) ?? false;
                      return (
                        // The row was one button until it grew a second action. A button cannot
                        // contain a button, so opening the session and opening its menu are now
                        // siblings, and the row's selected tint moves up to the item that holds
                        // both.
                        <li
                          key={key}
                          className={`flex items-center pr-1.5 ${active ? "bg-muted" : ""} ${
                            offCanvas ? "opacity-55" : ""
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => onSelectSession(bot, session)}
                            aria-current={active ? "page" : undefined}
                            title={offCanvas ? "Off the canvas" : undefined}
                            className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pr-2 pl-14 text-left text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80"
                          >
                            <span className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-meta,13px)">
                              {session.title || session.sessionId}
                            </span>
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
                      <li key={attachedSessionKey(ref)} className="flex min-h-9 items-center gap-2 py-1 pr-1.5 pl-14 text-xs text-muted-foreground">
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
                  <p className="pb-2 pr-3 pl-14 text-xs text-muted-foreground">No sessions attached</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
