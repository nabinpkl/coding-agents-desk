/**
 * Which Bots the canvas is NOT showing, remembered across visits.
 *
 * A subtraction rather than a guest list, and that is the whole design. The canvas means "every Bot
 * at once"; a list of the ones it shows would have to be added to every time a Bot is created, and
 * a Bot made anywhere else would arrive invisible. Detaching is the only edit, so a new Bot is on
 * the canvas by definition and the stored set stays empty until someone says otherwise.
 *
 * Detaching takes a Bot off THIS canvas and nothing else. The Bot, its curated sessions and every
 * transcript behind them are untouched, and the Bots tab still lists it -- the same relationship a
 * session row's "Remove from bot" has to the session it drops. Which is why this lives in the
 * browser rather than in the sidecar: it is how one reader has arranged one canvas, not a fact
 * about the Bot.
 */
const STORAGE_KEY = "agent-panel.bot-canvas.detached";

export function loadDetachedBotIds(): ReadonlySet<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0));
  } catch {
    return new Set();
  }
}

export function storeDetachedBotIds(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // The canvas keeps this session's arrangement in memory when storage is disabled.
  }
}

/**
 * The set with one Bot added or removed.
 *
 * A new set rather than a mutation, because React decides whether to re-render by identity and a
 * set edited in place is the same set.
 */
export function withBotDetached(ids: ReadonlySet<string>, botId: string, detached: boolean): ReadonlySet<string> {
  const next = new Set(ids);
  if (detached) next.add(botId);
  else next.delete(botId);
  return next;
}
