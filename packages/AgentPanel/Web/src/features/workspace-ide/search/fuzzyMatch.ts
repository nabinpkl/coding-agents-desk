// Fuzzy matching of file paths, for quick open.
//
// The shape of VS Code's and fzf's scorers, small enough to read: the query's characters must
// appear in the path in order, and among the ways they can, the best is the one that lands on
// word starts, runs of consecutive characters, and the file's own name rather than its folders.
// `wside` finds `WorkspaceIdeSurface.tsx` because W, S, Ide and the run "ide" all score.
//
// It runs in the panel over the whole file list on every keystroke. A fast subsequence test turns
// nearly every path away before the scoring pass, which is quadratic only in the query.

export interface FuzzyMatch {
  path: string;
  score: number;
  /** Indices into `path` of the characters that matched, for highlighting. */
  positions: number[];
}

/** What a filter did, counted so a test can check its cost without timing it. */
export interface FuzzyWork {
  /** Query pieces that passed the subsequence test and went through the scoring pass. */
  scored: number;
}

const WORD_START = 8;
const SEPARATOR_AFTER = 7;
const CAMEL = 6;
const CONSECUTIVE = 5;
const IN_NAME = 2;
/** Every character of a piece inside the file name, not spread across folders. */
const WHOLLY_IN_NAME = 10;
/** The file name starts with the piece: `agents` for `AGENTS.md`. */
const NAME_PREFIX = 15;
const WORD_END = 8;
const EXACT_CASE = 1;
const GAP = 1;

const NONE = Number.NEGATIVE_INFINITY;

function isSeparator(character: string): boolean {
  return character === "/" || character === "-" || character === "_" || character === "." || character === " ";
}

/** ASCII capitals only: a camel hump in a path is an ASCII one, and this runs per character. */
function isUpper(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 65 && code <= 90;
}

/** What starting a word here is worth: after a slash, after a separator, or a camel hump. */
function boundaryBonus(path: string, index: number): number {
  if (index === 0) return WORD_START;
  const previous = path[index - 1]!;
  if (previous === "/") return WORD_START;
  if (isSeparator(previous)) return SEPARATOR_AFTER;
  return isUpper(path[index]!) && !isUpper(previous) ? CAMEL : 0;
}

/** Whether `query` appears in `lowered` in order. The cheap test that rejects nearly everything. */
function isSubsequence(query: string, lowered: string): boolean {
  let at = 0;
  for (const character of query) {
    at = lowered.indexOf(character, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

/**
 * Score one path against one query piece, or null when it does not match.
 *
 * `best[i][j]` is the best score with query character `i` landing on path character `j`. A gap
 * costs one point per skipped character, so the running maximum of `best[i-1][k] + k` over
 * `k < j - 1` gives the best non-adjacent predecessor in constant time; the adjacent one gets the
 * consecutive bonus instead. Backpointers recover the positions.
 */
// Scratch rows reused across every path scored, grown when a longer path arrives. Allocating them
// per path was most of the cost: 69ms a keystroke over an 18,705-file list, measured 2026-09-30.
let rowA = new Float64Array(256);
let rowB = new Float64Array(256);
let backs = new Int32Array(256 * 8);

function scorePiece(
  path: string,
  lowered: string,
  query: string,
  work: FuzzyWork | undefined,
): { score: number; positions: number[] } | null {
  const loweredQuery = query.toLowerCase();
  if (!isSubsequence(loweredQuery, lowered)) return null;
  if (work) work.scored += 1;
  const length = path.length;
  const count = loweredQuery.length;
  const nameStart = path.lastIndexOf("/") + 1;
  if (rowA.length < length) {
    rowA = new Float64Array(length * 2);
    rowB = new Float64Array(length * 2);
  }
  if (backs.length < length * count) backs = new Int32Array(length * count * 2);
  let previous = rowA;
  let current = rowB;
  previous.fill(NONE, 0, length);

  for (let i = 0; i < count; i += 1) {
    current.fill(NONE, 0, length);
    const row = i * length;
    backs.fill(-1, row, row + length);
    // Best `previous[k] + k * GAP` over k < j - 1, carried along j.
    let carried = NONE;
    let carriedAt = -1;
    for (let j = i; j < length; j += 1) {
      if (i > 0 && j >= 2) {
        const k = j - 2;
        if (previous[k]! !== NONE && previous[k]! + k * GAP > carried) {
          carried = previous[k]! + k * GAP;
          carriedAt = k;
        }
      }
      if (lowered[j] !== loweredQuery[i]) continue;
      const boundary = boundaryBonus(path, j);
      const own = boundary + (j >= nameStart ? IN_NAME : 0) + (path[j] === query[i] ? EXACT_CASE : 0);
      if (i === 0) {
        // The first character pays for how far into the path it lands, but only lightly, so a
        // match in the file name deep in a tree still beats a scattered one near the root.
        current[j] = own - Math.min(j, 12) * 0.1;
        continue;
      }
      let best = NONE;
      let bestAt = -1;
      if (carriedAt >= 0) {
        best = carried - (j - 1) * GAP;
        bestAt = carriedAt;
      }
      // A run takes the larger of its own bonus and the boundary's rather than both: summing them
      // let `AgentSay` outscore `AGENTS` for "agents", the S of "Say" being a run AND a camel hump.
      if (j >= 1 && previous[j - 1]! !== NONE && previous[j - 1]! + Math.max(CONSECUTIVE - boundary, 0) >= best) {
        best = previous[j - 1]! + Math.max(CONSECUTIVE - boundary, 0);
        bestAt = j - 1;
      }
      if (bestAt < 0) continue;
      current[j] = best + own;
      backs[row + j] = bestAt;
    }
    [previous, current] = [current, previous];
  }

  let end = -1;
  let score = NONE;
  for (let j = 0; j < length; j += 1) {
    if (previous[j]! > score) {
      score = previous[j]!;
      end = j;
    }
  }
  if (end < 0) return null;
  const positions = new Array<number>(count);
  for (let i = count - 1, j = end; i >= 0; i -= 1) {
    positions[i] = j;
    j = backs[i * length + j]!;
  }
  if (positions[0]! >= nameStart) score += WHOLLY_IN_NAME;
  if (lowered.startsWith(loweredQuery, nameStart)) score += NAME_PREFIX;
  // The match ends where a word ends -- at a dot, a separator, a camel hump, or the path's end --
  // so `agents` prefers `AGENTS.md` to `AgentSayLocalServer`, which it only begins.
  const last = positions[count - 1]!;
  const after = path[last + 1];
  if (after === undefined || isSeparator(after) || (isUpper(after) && !isUpper(path[last]!))) {
    score += WORD_END;
  }
  return { score, positions };
}

/**
 * Score one path against a whole query, or null.
 *
 * Spaces split the query into pieces that must each match, in any order, the way VS Code's
 * quick open reads `ide surface`.
 */
export function fuzzyScore(path: string, query: string, work?: FuzzyWork): FuzzyMatch | null {
  const pieces = query.split(/\s+/).filter(Boolean);
  if (pieces.length === 0) return { path, score: 0, positions: [] };
  const lowered = path.toLowerCase();
  let score = 0;
  const positions = new Set<number>();
  for (const piece of pieces) {
    const scored = scorePiece(path, lowered, piece, work);
    if (!scored) return null;
    score += scored.score;
    for (const position of scored.positions) positions.add(position);
  }
  // Shorter paths win ties: `src/app.ts` over `src/features/app/app.test.ts` for "app".
  return { path, score: score - path.length * 0.01, positions: [...positions].sort((a, b) => a - b) };
}

/** The best `limit` matches, best first. */
export function fuzzyFilter(paths: readonly string[], query: string, limit: number, work?: FuzzyWork): FuzzyMatch[] {
  const matches: FuzzyMatch[] = [];
  for (const path of paths) {
    const match = fuzzyScore(path, query, work);
    if (match) matches.push(match);
  }
  matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return matches.slice(0, limit);
}
