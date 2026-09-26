/**
 * What to call a fork the panel is about to start.
 *
 * It lives here because the moment is the only one there is: `-n` sets a session's ADDRESS as
 * well as its title, so the name has to be settled before the CLI is run and cannot be corrected
 * afterwards without leaving the session listed under the wrong one in between.
 *
 * A fork onto a Bot does NOT use this: it starts under the Bot's next anchor with an empty task
 * (`AD 3`), spent from the Bot's slot counter. This is only for a fork that belongs to nobody,
 * which has no anchor and counts past its project's titles instead.
 *
 * # Forks
 *
 * The CLI names a fork nothing at all: measured 2026-09-07, `claude --resume <id> --fork-session`
 * with no `-n` produced a session whose registry `name` and transcript `customTitle` were both
 * byte-identical to its source's. So two forks of one session are two rows with one name, and the
 * cross-session address they answer to is the same string -- which is why six sessions on this
 * machine were all called "Windows canvas" and none of them could be addressed by name.
 *
 * `-n` sets BOTH of those names in one go, so naming the fork here fixes the panel's list and
 * `ListAgents` at the same time.
 *
 * This is the PROPOSAL, not the name. It seeds the field in the fork dialog and the reader may
 * type over it, which is why the rule lives on this side now: the sidecar used to derive the name
 * and had the last word on it, and a reader who wanted their fork called something else had to
 * rename it afterwards. The sidecar is handed a finished title and no longer names anything.
 */

/** `<base> (fork <n>)`, with the number captured so an existing suffix can be read off. */
const FORK_SUFFIX = /^(.*\S)\s*\(fork (\d+)\)$/;

/**
 * The title a fork is a fork OF, which is not always its source's title.
 *
 * Forking a fork should give `(fork 3)`, not `Thing (fork 2) (fork 1)`: the suffix names which
 * fork of the original this is, so it accumulates a number rather than another suffix.
 */
export function forkBaseTitle(title: string): string {
  const trimmed = title.trim();
  const suffix = FORK_SUFFIX.exec(trimmed);
  return suffix ? suffix[1]! : trimmed;
}

/**
 * The next free `(fork n)` for a source title, given the titles already in its project.
 *
 * Counts from what exists rather than from how many forks this process has made, because the
 * sidecar is not the only thing that forks a session and it does not outlive the transcripts. The
 * numbers are read off the titles themselves, so a gap left by a deleted fork is reused and a fork
 * made by hand is still counted.
 */
export function nextForkTitle(sourceTitle: string, takenTitles: Iterable<string>): string {
  const base = forkBaseTitle(sourceTitle) || sourceTitle.trim();
  let highest = 0;
  for (const taken of takenTitles) {
    const suffix = FORK_SUFFIX.exec(taken.trim());
    if (!suffix || suffix[1] !== base) continue;
    highest = Math.max(highest, Number(suffix[2]));
  }
  return `${base} (fork ${highest + 1})`;
}
