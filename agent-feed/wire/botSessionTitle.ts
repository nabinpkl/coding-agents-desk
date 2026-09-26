// A Bot session's title in two halves: a stable anchor, then what it is doing.
//
// The anchor is a plain English name (`Aaron`, `Maya`), allocated once per session from the pool
// below and stored on the Bot's record. It is never the Bot's name plus a number: numbers get
// re-read as ranks and re-counted from titles, which is the collision this replaces. The bracket
// holds the task (`Aaron (checkout flow)`), which the reader sets at launch and a Bot will later
// rename itself as its work changes. The anchor is the stable half other surfaces can hold onto
// while the bracket churns; the full title stays the `-n` name and the `/resume` title, so
// nothing about addressing changes, only what the string is made of.
//
// Allocation is first-free over the names already stored, machine-wide: two Bots never hand out
// the same anchor, and a freed name is never reused, so history cannot collide. Both trees import
// this: the sidecar allocates and composes at launch, the panel previews the same answer in its
// dialogs. One home for the format, so the two cannot drift.

/** Every anchor ever handed out, in allocation order. Plain first names, nothing to re-read. */
const ANCHOR_POOL = [
  "Aaron", "Adam", "Alan", "Albert", "Alice", "Amelia", "Andrew", "Angela",
  "Anna", "Arthur", "Audrey", "Austin", "Beatrice", "Benjamin", "Bernard", "Bonnie",
  "Bradley", "Brenda", "Brian", "Bridget", "Bruce", "Caleb", "Calvin", "Cameron",
  "Carl", "Carmen", "Carol", "Caroline", "Claire", "Clara", "Clarence", "Clifford",
  "Clinton", "Colin", "Connie", "Cora", "Curtis", "Daisy", "Daniel", "David",
  "Dean", "Deborah", "Dennis", "Diana", "Donald", "Donna", "Doris", "Douglas",
  "Dylan", "Edith", "Edmund", "Edward", "Edwin", "Eleanor", "Elias", "Elijah",
  "Eliza", "Ella", "Ellen", "Elmer", "Emily", "Emma", "Eric", "Erica",
  "Esther", "Ethan", "Ethel", "Eugene", "Eva", "Evan", "Evelyn", "Faith",
  "Felix", "Flora", "Florence", "Floyd", "Frances", "Francis", "Frank", "Fred",
  "Gabriel", "Gene", "George", "Georgia", "Gerald", "Gina", "Glen", "Gloria",
  "Gordon", "Grace", "Graham", "Grant", "Greta", "Hannah", "Harold", "Harriet",
  "Harvey", "Hazel", "Helen", "Henry", "Herbert", "Herman", "Hilda", "Holly",
  "Howard", "Hugh", "Hugo", "Ian", "Ida", "Irene", "Iris", "Isaac",
  "Isabel", "Ivan", "Jack", "Jacob", "James", "Jane", "Janet", "Jason",
  "Jeffrey", "Jennifer", "Jeremy", "Jerome", "Jesse", "Jessica", "Jill", "Joan",
];

/** The first pool name nobody holds, so allocation is deterministic given the same state. */
export function firstFreeAnchor(taken: Iterable<string>): string {
  const held = new Set(taken);
  for (const name of ANCHOR_POOL) {
    if (!held.has(name)) return name;
  }
  // Past the pool: the name stays stable, the number only says which lap. Rare enough that the
  // numbering carries no meaning worth designing around.
  let lap = 2;
  for (;;) {
    for (const name of ANCHOR_POOL) {
      if (!held.has(`${name} ${lap}`)) return `${name} ${lap}`;
    }
    lap += 1;
  }
}

/** The full title: the anchor alone, or the anchor with the task in brackets. */
export function formatBotSessionTitle(anchor: string, task: string): string {
  const label = task.trim();
  return label ? `${anchor.trim()} (${label})` : anchor.trim();
}

/** Splits a title into its anchor and its bracket task. No bracket means no task. */
export function parseBotSessionTitle(title: string): { anchor: string; task: string } {
  const match = /^(.*\S)\s+\(([^()]*)\)\s*$/.exec(title.trim());
  if (!match) return { anchor: title.trim(), task: "" };
  return { anchor: match[1]!, task: match[2]!.trim() };
}

/** Why a task label cannot be bracketed as-is, or null when it can. */
export function refuseTaskText(task: string): string | null {
  if (/[\n\r]/.test(task)) return "a session task cannot contain a line break";
  // The brackets are the format: a task carrying its own would not parse back.
  if (/[()]/.test(task)) return "a session task cannot contain parentheses";
  return null;
}

/**
 * Reads the task half out of text somebody typed, against the anchor that will prefix it.
 *
 * A trailing bracket names the task even when its anchor is stale; a bare anchor prefix is
 * stripped so an old title normalizes instead of nesting (`Chatbot extraction` seeds
 * `extraction` under `Chatbot`); anything else is the task whole. One function for the launch
 * path and the rename dialog, so both read the same way.
 */
export function taskFromText(text: string, anchor: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const parsed = parseBotSessionTitle(trimmed);
  if (parsed.task) return parsed.task;
  if (trimmed === anchor) return "";
  if (trimmed.startsWith(anchor)) {
    const rest = trimmed.slice(anchor.length);
    // A word boundary, not a prefix: `ADX 7` is not `AD` plus a task.
    if (/^\s/.test(rest)) return rest.trim();
  }
  return trimmed;
}

/**
 * The task an old title carries into its anchor shape.
 *
 * Trailing bracket groups are the previous era's suffixes (`(fork 3)`), so they are stripped
 * rather than nested. What is left must still bracket cleanly; when it does not, the session
 * starts bare and the caller says so.
 */
export function backfillTaskText(oldTitle: string): string {
  return oldTitle.replace(/(\s+\([^()]*\))+\s*$/, "").trim();
}
