// What a Codex tool call row says it did.
//
// Codex writes a tool call's arguments three ways, and only one of them was
// being read. `function_call` carries JSON. `custom_tool_call` carries either
// JavaScript source driving one `tools.<verb>(...)` call, or -- for
// `apply_patch` -- a bare patch document. Across the 832 rollouts here that left
// two populations rendering as their bare tool name: all 38,737 custom tool
// calls (which shared two summaries between them, "exec" and "apply_patch"), and
// 11,951 function calls whose first JSON argument is a number or an array rather
// than a string, `write_stdin` foremost at 9,700.
//
// All three shapes are machine-generated and put the interesting value at a
// known key per verb, so the rules are per verb and the readers feed them. Two
// readers -- one walking JavaScript source, one walking a parsed JSON value --
// both produce an ordered list of `key -> scalar` pairs; one rule table then
// picks which key names the row. A verb the table does not know falls to the
// first real argument, which covers the MCP and app-automation tail.
//
// This reads generated source; it is not a JavaScript parser. No rule guesses:
// one that cannot find the argument it wants gives back nothing, the row falls
// back to naming the verb or the tool, and what was actually written stays one
// Raw JSON press away.
//
import { basename } from "node:path";

/**
 * Beyond this many files or images a row names the first few and counts the rest.
 * Six covers 98.2% of the 3,219 `patch_apply_end` records here outright (2,335
 * touch one file, the largest touches 20). Exported so `patchFileSummary`, which
 * reads a different payload for the same kind of row, names the same count.
 */
export const ITEMS_NAMED = 6;

export const PATCH_CHANGE_MARKS: Readonly<Record<string, string>> = {
  add: "A",
  update: "M",
  delete: "D",
};

/** Every one of the 17,065 patch payloads measured here opens with this line. */
const PATCH_OPENING = "*** Begin Patch";

const SUMMARY_MAX = 200;
/** Leaves room inside SUMMARY_MAX for the verb name in front of the detail. */
const HEAD_MAX = 150;
/** Leaves room for both a verb in front and a ` (+N more)` count behind. */
const MESSAGE_MAX = 110;

/** Namespace prefix on the sub-agent tools. Carries no information in a row. */
const VERB_NAMESPACE = /^multi_agent_v1__/;

/**
 * The sub-agent verbs, which arrive namespaced through a script and bare through
 * a function call. Both spellings take the same rule.
 */
const SUB_AGENT_VERBS: ReadonlySet<string> = new Set([
  "spawn_agent",
  "wait_agent",
  "send_input",
  "resume_agent",
  "close_agent",
  "list_agents",
]);

interface KeyedValue {
  key: string;
  value: string;
}

/**
 * Reads the JavaScript string literal starting at `i`. Handles ', " and
 * backticks, and honors backslash escapes so an embedded quote does not end it
 * early -- the shell commands here are full of them. Returns null when `i` is
 * not a quote or the literal never closes.
 */
function readStringLiteral(source: string, i: number): { value: string; end: number } | null {
  const quote = source[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let value = "";
  for (let j = i + 1; j < source.length; j += 1) {
    const char = source[j];
    if (char === "\\") {
      const escaped = source[j + 1];
      if (escaped === undefined) break;
      value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
      j += 1;
      continue;
    }
    if (char === quote) return { value, end: j };
    value += char;
  }
  return null;
}

/**
 * Every `key: <string|number>` pair in source order.
 *
 * One left-to-right pass that steps over string literals rather than scanning
 * inside them, so a `cmd:` occurring within a shell command cannot be mistaken
 * for an argument key. A key whose value is an array or object stays pending and
 * attaches to the literals inside it, which is what makes `{targets:["a","b"]}`
 * and `{search_query:[{q:"..."}]}` both readable.
 */
function keyedValues(source: string): KeyedValue[] {
  const pairs: KeyedValue[] = [];
  let pendingKey = "";
  let i = 0;
  const skipSpace = (from: number): number => {
    let j = from;
    while (j < source.length && /\s/.test(source.charAt(j))) j += 1;
    return j;
  };
  while (i < source.length) {
    const char = source.charAt(i);
    if (char === '"' || char === "'" || char === "`") {
      const literal = readStringLiteral(source, i);
      if (!literal) {
        i += 1;
        continue;
      }
      const after = skipSpace(literal.end + 1);
      if (source.charAt(after) === ":") {
        pendingKey = literal.value;
        i = after + 1;
        continue;
      }
      if (pendingKey) pairs.push({ key: pendingKey, value: literal.value });
      i = literal.end + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = i;
      while (end < source.length && /[\w$]/.test(source.charAt(end))) end += 1;
      const after = skipSpace(end);
      if (source.charAt(after) === ":") {
        pendingKey = source.slice(i, end);
        i = after + 1;
        continue;
      }
      i = end;
      continue;
    }
    if (/\d/.test(char) && pendingKey) {
      let end = i;
      while (end < source.length && /[\d.]/.test(source.charAt(end))) end += 1;
      pairs.push({ key: pendingKey, value: source.slice(i, end) });
      pendingKey = "";
      i = end;
      continue;
    }
    i += 1;
  }
  return pairs;
}

/**
 * The same pairs, read out of a parsed JSON value instead of source.
 *
 * Depth-first so the pairs arrive in the order they were written, and an array's
 * members inherit the key that introduced them -- matching what the script
 * reader does with `{targets:["a","b"]}`, so one rule serves both spellings of a
 * verb. Booleans and nulls are skipped: `success: true` names no row.
 */
function jsonValues(value: unknown, key = "", pairs: KeyedValue[] = []): KeyedValue[] {
  if (Array.isArray(value)) {
    for (const item of value) jsonValues(item, key, pairs);
    return pairs;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) jsonValues(child, childKey, pairs);
    return pairs;
  }
  if (key && (typeof value === "string" || typeof value === "number")) {
    pairs.push({ key, value: String(value) });
  }
  return pairs;
}

function valuesFor(pairs: KeyedValue[], key: string): string[] {
  return pairs.filter((pair) => pair.key === key).map((pair) => pair.value);
}

/** The verb the script spends most of its calls on. */
function primaryVerb(source: string): string {
  const counts = new Map<string, number>();
  for (const [, verb] of source.matchAll(/\btools\.([A-Za-z_]\w*)/g)) {
    if (!verb) continue;
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [verb, count] of counts) {
    if (count > bestCount) {
      best = verb;
      bestCount = count;
    }
  }
  return best;
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").trim();
}

/**
 * `git status  (+3 more)` -- names the first item and counts what it stands for.
 *
 * The count covers both siblings and the first item's own extra lines. The
 * panel's collapsed preview cuts at the first newline, so without the second
 * count a heredoc reads as `python - <<'PY'` and everything the script actually
 * did is gone with no sign that anything was dropped. 3,252 commands here span
 * more than one line, a mean of 3.7 hidden lines each.
 */
function nameFirstCountRest(items: string[]): string {
  const [first] = items;
  if (first === undefined) return "";
  const siblings = items.length - 1;
  const extraLines = first.split("\n").length - 1;
  // A row with no suffix to fit gets the whole budget; a command is the most
  // informative thing a row can carry and was never cut short before.
  const head = firstLine(first).slice(0, siblings || extraLines ? MESSAGE_MAX : SUMMARY_MAX);
  if (siblings > 0) return `${head}  (+${siblings} more)`;
  if (extraLines > 0) return `${head}  (+${extraLines} more line${extraLines === 1 ? "" : "s"})`;
  return head;
}

/** A shell command as a row: its first line, and how much of it is not shown. */
export function commandSummary(command: string): string {
  return nameFirstCountRest([command]).slice(0, SUMMARY_MAX);
}

/** `M FileTab.swift, A New.swift, +2 more` */
function nameEach(items: string[]): string {
  if (items.length === 0) return "";
  const named = items.slice(0, ITEMS_NAMED);
  const rest = items.length - named.length;
  return `${named.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
}

/**
 * The files a patch document touches, from its `*** <Verb> File:` headers.
 *
 * Works on a bare patch payload and on one embedded in a script, which is why it
 * reads the headers rather than the surrounding syntax. All 17,065 `apply_patch`
 * payloads measured here open with `*** Begin Patch`.
 */
function patchFilesFromText(text: string): string {
  const headers = [...text.matchAll(/\*\*\* (Add|Update|Delete) File:[ \t]*(.+)/g)];
  if (headers.length === 0) return "";
  const files = headers.map((header) => {
    const mark = PATCH_CHANGE_MARKS[(header[1] ?? "").toLowerCase()] ?? "?";
    // A patch embedded in a script has its line breaks written as the two
    // characters backslash-n, which no line-oriented pattern stops at. Without
    // this cut the "path" runs on into the diff and the whole patch lands in the
    // row -- the failure this module exists to remove.
    const path = ((header[2] ?? "").split("\\n")[0] ?? "").trim();
    return `${mark} ${basename(path)}`;
  });
  return nameEach(files);
}

type VerbRule = (pairs: KeyedValue[], source: string) => string;

const VERB_RULES: Readonly<Record<string, VerbRule>> = {
  // The command is the row. Multiple `cmd`s mean a Promise.all fan-out.
  exec_command: (pairs) => nameFirstCountRest(valuesFor(pairs, "cmd")),

  // Feeding an already-running shell. Most of these send nothing and exist only
  // to collect more output, which is worth saying rather than showing as blank.
  write_stdin: (pairs) => {
    const session = valuesFor(pairs, "session_id")[0];
    if (!session) return "";
    const typed = firstLine(valuesFor(pairs, "chars")[0] ?? "");
    return typed ? `session ${session}  ${typed.slice(0, MESSAGE_MAX)}` : `session ${session}  (poll)`;
  },

  apply_patch: (_pairs, source) => patchFilesFromText(source),

  // A search carries `search_query`; a fetch carries `open`/`find` targets.
  web__run: (pairs) => nameFirstCountRest(valuesFor(pairs, "q")) || nameFirstCountRest(valuesFor(pairs, "ref_id")),

  view_image: (pairs) => nameEach(valuesFor(pairs, "path").map((path) => basename(path))),

  update_plan: (pairs) => {
    const steps = valuesFor(pairs, "step");
    const [first] = steps;
    if (first !== undefined) {
      return `${steps.length} step${steps.length === 1 ? "" : "s"} · ${firstLine(first).slice(0, MESSAGE_MAX)}`;
    }
    return firstLine(valuesFor(pairs, "explanation")[0] ?? "").slice(0, HEAD_MAX);
  },
};

/** Sub-agent verbs all address agents by id and mostly carry a message. */
function subAgentDetail(pairs: KeyedValue[]): string {
  const message = valuesFor(pairs, "message")[0];
  if (message) return firstLine(message).slice(0, HEAD_MAX);
  const targets = new Set([...valuesFor(pairs, "target"), ...valuesFor(pairs, "targets")]);
  if (targets.size === 0) return "";
  return `${targets.size} agent${targets.size === 1 ? "" : "s"}`;
}

/** Knobs that describe the harness rather than the work. */
const HARNESS_KEYS = /^(yield_time_ms|max_output_tokens|timeout|detail|type|status)$/;

/**
 * The first argument of the call, for verbs with no rule of their own.
 *
 * Covers the long tail -- MCP tools, app automation, sub-agent bookkeeping --
 * where the first argument is the query, title, or path and names the row well
 * enough. Words are preferred over numbers wherever both are present, but a
 * number still beats nothing: `wait`'s only argument is a session id, and it is
 * the entire content of the row.
 */
function firstArgumentDetail(pairs: KeyedValue[]): string {
  let fallback = "";
  for (const pair of pairs) {
    if (HARNESS_KEYS.test(pair.key)) continue;
    const text = firstLine(pair.value);
    if (!text) continue;
    if (/[^\d.]/.test(text)) return text.slice(0, HEAD_MAX);
    if (!fallback) fallback = text.slice(0, HEAD_MAX);
  }
  return fallback;
}

/**
 * A one-line summary for a `custom_tool_call` payload, or '' when nothing in it
 * reads cleanly.
 *
 * `toolName` is the name on the record. The verb is dropped from the summary
 * when it repeats that name, and for `exec_command`, whose detail is a shell
 * command that names itself -- matching how the JSON-argument `exec_command`
 * rows already read.
 */
export function summarizeScriptCall(raw: string, toolName: string): string {
  if (!raw.trim()) return "";
  // A bare patch document, recognized by its own opening line rather than by the
  // absence of script syntax: a diff that happens to add a line mentioning
  // `tools.` would otherwise be read as a script and labelled with a verb picked
  // out of the patched file's contents.
  if (raw.trimStart().startsWith(PATCH_OPENING)) {
    return patchFilesFromText(raw).slice(0, SUMMARY_MAX);
  }
  const verb = primaryVerb(raw);
  if (!verb) return "";
  return compose(verb, toolName, keyedValues(raw), raw);
}

/**
 * The same summary for a `function_call`'s JSON arguments, or '' when the
 * payload carries nothing worth a row.
 *
 * The verb is the tool's own name here, so the rules that read a script's
 * `tools.<verb>(...)` call apply unchanged. This exists because the adapter's
 * generic rule required the FIRST key to hold a string: `write_stdin` leads with
 * a numeric `session_id` and `update_plan` with an array, so 11,951 rows fell
 * past it to the bare tool name with their arguments sitting right there.
 */
export function summarizeJsonCall(input: Record<string, unknown>, toolName: string): string {
  if (Object.keys(input).length === 0) return "";
  return compose(toolName, toolName, jsonValues(input), "");
}

function compose(verb: string, toolName: string, pairs: KeyedValue[], source: string): string {
  const bare = verb.replace(VERB_NAMESPACE, "");
  const rule = VERB_RULES[verb];
  // A verb with a rule never falls through to the generic reader: when the rule
  // finds nothing the argument it wanted was computed rather than written down,
  // and the next literal in the source is something else entirely -- a workdir,
  // not a command. Naming the verb alone is the honest answer there.
  const ruled = SUB_AGENT_VERBS.has(bare) ? subAgentDetail(pairs) : rule ? rule(pairs, source) : "";
  const detail = ruled || (rule ? "" : firstArgumentDetail(pairs));
  // A rule's detail says what the call did, so repeating the name the row's chip
  // already shows just gives back the "exec exec" this replaces. The generic
  // reader's detail is a bare argument value, which needs the name to make sense
  // -- and keeping it there is the convention the Claude adapter also follows.
  const named = ruled && (verb === toolName || verb === "exec_command") ? "" : bare;
  return [named, detail].filter(Boolean).join(" ").slice(0, SUMMARY_MAX);
}
