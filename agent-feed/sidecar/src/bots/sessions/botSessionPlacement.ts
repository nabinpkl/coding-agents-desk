// Which Bot a session belongs on when a reader moves it to the canvas, and what a Bot made for it is
// called.
//
// A session's home is decided by its directory, by the same predicate attaching checks: the
// directory itself or a git worktree of it. So a session working in a worktree lands on its
// checkout's Bot, and a Bot made for it is bound to the checkout rather than to the worktree,
// because a worktree is one branch of a repository and a Bot is the repository's.

import { basename, dirname } from "node:path";
import type { BotRecord } from "@agentdesk/agent-feed-wire";
import { directoryBelongsTo, worktreeOf } from "@/git/worktree";

/** The directory a Bot made for a session working in `projectPath` is bound to. */
export async function placementDirectory(projectPath: string): Promise<string> {
  return (await worktreeOf(projectPath))?.mainCheckout ?? projectPath;
}

/**
 * The Bot already bound to where `projectPath` works, if any.
 *
 * An exact match first, which is free and is the ordinary case; the worktree question reads the
 * disk, so it is asked only when no Bot names the directory itself.
 */
export async function placementBot(bots: readonly BotRecord[], projectPath: string): Promise<BotRecord | undefined> {
  const exact = bots.find((bot) => bot.environment.path === projectPath);
  if (exact) return exact;
  for (const bot of bots) {
    if (await directoryBelongsTo(projectPath, bot.environment.path)) return bot;
  }
  return undefined;
}

/**
 * A name for a Bot made for `directory`, unique among `bots`.
 *
 * The directory's own name, which is what a reader calls the project. Names are unique ignoring
 * case and two checkouts can share one -- two `web` folders -- so a taken name gains its parent
 * folder, `web (agent-desk)`, and only if that is taken too a number.
 */
export function placementName(directory: string, bots: readonly BotRecord[], maximum: number): string {
  const taken = new Set(bots.map((bot) => fold(bot.name)));
  const base = basename(directory) || directory;
  const parent = basename(dirname(directory));
  const candidates = [base, ...(parent && parent !== base ? [`${base} (${parent})`] : [])];
  for (const candidate of candidates) {
    const clipped = candidate.slice(0, maximum);
    if (!taken.has(fold(clipped))) return clipped;
  }
  const stem = candidates.at(-1)!;
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`;
    const numbered = `${stem.slice(0, maximum - suffix.length)}${suffix}`;
    if (!taken.has(fold(numbered))) return numbered;
  }
}

/** The comparison Bot names are unique under, the one `add` refuses a duplicate by. */
function fold(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("en-US");
}
