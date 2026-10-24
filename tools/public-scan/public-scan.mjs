#!/usr/bin/env node
// Keeps personal data and secret-shaped strings out of this tree, so it can be published.
// README.md beside this file says how the two rule sets, the baseline and the three modes fit.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runtimePaths } from "../runtime-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RULE_LINE = /^([a-z0-9][a-z0-9-]*)\s+\/(.+)\/([imsuv]*)$/;
// Text hidden in base64 is decoded and scanned as well: a captured payload carried an account id
// and home paths that way, past every plain grep. 64 characters is 48 bytes: long enough that
// ordinary identifiers do not qualify, short enough to catch one header.
const BASE64_RUN = /[A-Za-z0-9+/]{64,}={0,2}/g;
// A binary file is not skipped outright: its printable runs are scanned, the way `strings` reads
// one, so a name in image metadata or a compiled string table still counts.
const PRINTABLE_RUN = /[\x20-\x7e]{8,}/g;
const BINARY_PROBE_BYTES = 8000;
const SHOWN_PER_ENTRY = 20;
const SHOWN_PER_RULE = 40;

export const DEFAULTS = {
  root: resolve(HERE, "..", ".."),
  secretRulesPath: join(HERE, "secret-rules.txt"),
  baselinePath: join(HERE, "baseline.tsv"),
};

/** One rule per line, `<id> /<regex>/<flags>`; blank lines and `#` comments are skipped. */
export function parseRules(text, source) {
  const rules = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const where = `${source}:${index + 1}`;
    const match = RULE_LINE.exec(line);
    if (!match) throw new Error(`${where}: expected "<id> /<regex>/<flags>" with flags from imsuv`);
    const [, id, pattern, flags] = match;
    let regex;
    try {
      regex = new RegExp(pattern, `${flags}g`);
    } catch (error) {
      throw new Error(`${where}: ${error.message}`, { cause: error });
    }
    if (new RegExp(pattern, flags).test("")) throw new Error(`${where}: rule ${id} matches an empty string`);
    rules.push({ id, regex, source });
  }
  return rules;
}

/** The checked-in secret shapes, plus the machine's personal denylist when it has one. */
export function loadRules({ secretRulesPath, denylistPath }) {
  const rules = parseRules(readFileSync(secretRulesPath, "utf8"), secretRulesPath);
  const denylistFound = existsSync(denylistPath);
  if (denylistFound) rules.push(...parseRules(readFileSync(denylistPath, "utf8"), denylistPath));
  const sources = new Map();
  for (const rule of rules) {
    if (sources.has(rule.id)) {
      throw new Error(`rule id ${rule.id} is defined twice: in ${sources.get(rule.id)} and ${rule.source}`);
    }
    sources.set(rule.id, rule.source);
  }
  return { rules, denylistFound };
}

/** Every match of every rule in `text`, with its 1-based line. */
export function findHits(text, rules) {
  const hits = [];
  let starts;
  for (const rule of rules) {
    for (const match of text.matchAll(rule.regex)) {
      starts ??= lineStarts(text);
      hits.push({ rule: rule.id, line: lineOf(starts, match.index) });
    }
  }
  return hits;
}

/** Direct hits, then hits inside base64 runs that decode to text, reported on the run's line. */
export function scanText(text, rules) {
  const hits = findHits(text, rules);
  let starts;
  for (const match of text.matchAll(BASE64_RUN)) {
    const decoded = Buffer.from(match[0], "base64").toString("utf8");
    if (!looksLikeText(decoded)) continue;
    const inner = findHits(decoded, rules);
    if (inner.length === 0) continue;
    starts ??= lineStarts(text);
    const line = lineOf(starts, match.index);
    for (const hit of inner) hits.push({ rule: hit.rule, line, how: "base64" });
  }
  return hits;
}

/** Hits in a file's bytes: as text, or through its printable runs when it is binary. */
export function scanBytes(bytes, rules) {
  if (!bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return scanText(bytes.toString("utf8"), rules);
  const runs = bytes.toString("latin1").match(PRINTABLE_RUN) ?? [];
  return findHits(runs.join("\n"), rules).map((hit) => ({ rule: hit.rule, line: 0, how: "binary" }));
}

function looksLikeText(text) {
  let printable = 0;
  let total = 0;
  for (const character of text) {
    total += 1;
    const code = character.codePointAt(0);
    if (code !== 0xfffd && (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d)) printable += 1;
  }
  return total >= 16 && printable / total >= 0.95;
}

function lineStarts(text) {
  const starts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return starts;
}

function lineOf(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function git(root, args, input) {
  const result = spawnSync("git", ["-C", root, ...args], { input, maxBuffer: 1 << 30 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

function record(found, rule, where, detail) {
  const key = `${rule}\t${where}`;
  let entry = found.get(key);
  if (!entry) found.set(key, (entry = { rule, path: where, details: [] }));
  entry.details.push(detail);
}

function describe(hit) {
  return hit.how ? `${hit.line} (${hit.how})` : String(hit.line);
}

/** Every tracked file, and every untracked one git does not ignore, by path and by contents. */
export function scanTree(root, rules, excluded = new Set()) {
  const found = new Map();
  const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).toString("utf8");
  for (const path of new Set(listed.split("\0").filter(Boolean))) {
    if (excluded.has(path)) continue;
    for (const hit of findHits(path, rules)) record(found, hit.rule, path, "0");
    const bytes = readRegularFile(join(root, path));
    if (bytes === null) continue;
    for (const hit of scanBytes(bytes, rules)) record(found, hit.rule, path, describe(hit));
  }
  return found;
}

function readRegularFile(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    // Tracked but deleted in the working tree: nothing there to publish.
    if (error.code === "ENOENT") return null;
    throw error;
  }
  // A symlink's target string was already read as its path; a gitlink is a directory.
  return stat.isFile() ? readFileSync(file) : null;
}

const BASELINE_HEADER = [
  "# Hits public-scan allows because they were in the tree when its gate began, 2026-10-23.",
  "# It only ever shrinks: regenerate it with `just public-scan --update-baseline` after removing",
  "# some, never to make room for a new one. Columns: count, rule, path.",
];

export function formatBaseline(found) {
  const rows = [...found.values()]
    .sort((a, b) => (a.path === b.path ? compare(a.rule, b.rule) : compare(a.path, b.path)))
    .map((entry) => `${entry.details.length}\t${entry.rule}\t${entry.path}`);
  return `${[...BASELINE_HEADER, ...rows].join("\n")}\n`;
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function parseBaseline(text, source) {
  const baseline = new Map();
  for (const [index, raw] of text.split("\n").entries()) {
    if (raw === "" || raw.startsWith("#")) continue;
    const [count, rule, path, ...rest] = raw.split("\t");
    if (rest.length > 0 || !rule || !path || !/^[1-9][0-9]*$/.test(count)) {
      throw new Error(`${source}:${index + 1}: expected "<count><TAB><rule><TAB><path>"`);
    }
    baseline.set(`${rule}\t${path}`, Number(count));
  }
  return baseline;
}

/**
 * What the tree holds beyond the baseline, and where the baseline allows more than the tree holds.
 * Entries for rules not loaded here (a machine without the denylist) are counted, not judged.
 */
export function compareToBaseline(found, baseline, ruleIds) {
  const excess = [];
  for (const entry of found.values()) {
    const allowed = baseline.get(`${entry.rule}\t${entry.path}`) ?? 0;
    if (entry.details.length > allowed) excess.push({ ...entry, allowed });
  }
  const stale = [];
  let skipped = 0;
  for (const [key, allowed] of baseline) {
    const [rule, path] = key.split("\t");
    if (!ruleIds.has(rule)) {
      skipped += 1;
      continue;
    }
    const count = found.get(key)?.details.length ?? 0;
    if (count < allowed) stale.push({ rule, path, found: count, allowed });
  }
  return { excess, stale, skipped };
}

function summarize(found) {
  return { hits: [...found.values()].reduce((sum, entry) => sum + entry.details.length, 0),
    files: new Set([...found.values()].map((entry) => entry.path)).size };
}

function shown(details) {
  const listed = details.slice(0, SHOWN_PER_ENTRY).join(", ");
  return details.length > SHOWN_PER_ENTRY ? `${listed}, and ${details.length - SHOWN_PER_ENTRY} more` : listed;
}

/** The gate. `update` rewrites the baseline from the tree instead of judging it. */
export function runGate({ root, secretRulesPath, denylistPath, baselinePath, update = false }) {
  const out = [];
  const { rules, denylistFound } = loadRules({ secretRulesPath, denylistPath });
  if (!denylistFound) {
    if (update) {
      throw new Error(`refusing to rewrite the baseline without the denylist at ${denylistPath}: ` +
        "every personal-data entry in it would be dropped");
    }
    out.push(`public-scan: no denylist at ${denylistPath}; personal-data rules skipped, secret shapes still checked`);
  }
  const found = scanTree(root, rules, new Set([relative(root, baselinePath)]));
  if (update) {
    writeFileSync(baselinePath, formatBaseline(found));
    const { hits, files } = summarize(found);
    out.push(`public-scan: baseline rewritten: ${hits} hits in ${files} files`);
    return { status: 0, out };
  }
  const baseline = existsSync(baselinePath)
    ? parseBaseline(readFileSync(baselinePath, "utf8"), baselinePath)
    : new Map();
  const { excess, stale, skipped } = compareToBaseline(found, baseline, new Set(rules.map((rule) => rule.id)));
  if (excess.length > 0) {
    out.push("public-scan: new hits, as rule and path:line (line 0 is the path itself):");
    for (const entry of excess) {
      const already = entry.allowed > 0 ? `   (${entry.allowed} of these were already there)` : "";
      out.push(`  ${entry.rule}  ${entry.path}:${shown(entry.details)}${already}`);
    }
    const personal = denylistFound ? denylistPath : "no denylist on this machine";
    out.push(`public-scan: personal rules: ${personal}; secret shapes: ${relative(root, secretRulesPath)}.`);
    out.push("public-scan: take the string out. The baseline records what was already there when the " +
      "gate began, and is not a place to make room.");
  }
  if (stale.length > 0) {
    out.push("public-scan: the baseline allows more than the tree now holds:");
    for (const entry of stale) out.push(`  ${entry.rule}  ${entry.path}  ${entry.allowed} -> ${entry.found}`);
    out.push(`public-scan: record that with \`just public-scan --update-baseline\` and commit ` +
      `${relative(root, baselinePath)} with the change.`);
  }
  if (excess.length > 0 || stale.length > 0) return { status: 1, out };
  const { hits, files } = summarize(found);
  const note = skipped > 0 ? `; ${skipped} baseline entries are for rules not loaded here` : "";
  out.push(`public-scan: OK, ${rules.length} rules, ${hits} baselined hits left in ${files} files${note}`);
  return { status: 0, out };
}

async function* readBlobs(root, shas) {
  const child = spawn("git", ["-C", root, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "inherit"] });
  const closed = new Promise((resolve, reject) => {
    child.on("close", resolve);
    child.on("error", reject);
  });
  child.stdin.end(shas.length > 0 ? `${shas.join("\n")}\n` : "");
  let buffer = Buffer.alloc(0);
  let pending = null;
  for await (const chunk of child.stdout) {
    buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (pending === null) {
        const newline = buffer.indexOf(10);
        if (newline === -1) break;
        const [sha, type, size] = buffer.subarray(0, newline).toString("utf8").split(" ");
        if (type !== "blob") throw new Error(`git cat-file: ${sha} is ${type}, not a blob`);
        buffer = buffer.subarray(newline + 1);
        pending = { sha, size: Number(size) };
      }
      if (buffer.length < pending.size + 1) break;
      yield { sha: pending.sha, bytes: buffer.subarray(0, pending.size) };
      buffer = buffer.subarray(pending.size + 1);
      pending = null;
    }
  }
  const code = await closed;
  if (code !== 0) throw new Error(`git cat-file --batch exited ${code}`);
}

function installed(command) {
  const probe = spawnSync(command, ["version"]);
  return !probe.error && probe.status === 0;
}

function runGitleaks(command, root, revisions) {
  const directory = mkdtempSync(join(tmpdir(), "public-scan-gitleaks-"));
  try {
    const report = join(directory, "report.json");
    const result = spawnSync(command, ["git", "--no-banner", "--redact", "--report-format", "json",
      "--report-path", report, "--log-opts", revisions.join(" "), root], { encoding: "utf8" });
    // 1 is gitleaks reporting findings; anything else is gitleaks failing to run.
    if (result.status !== 0 && result.status !== 1) throw new Error(`gitleaks failed: ${result.stderr.trim()}`);
    return existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : [];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Every blob, path, commit message and commit identity reachable from `revisions` (git rev-list
 * arguments, such as `main` or `upstream/main..main`), plus gitleaks over the same commits. No
 * baseline: this is for a history about to be published, which must come up empty.
 *
 * `gitleaks` is the command to run. Without it installed this throws before reading anything,
 * because a history that passed without gitleaks would read as clean when half the check never ran.
 * `false` leaves gitleaks out, which only the tests' fixture repositories do.
 */
export async function runHistory({ root, rules, revisions, gitleaks = "gitleaks" }) {
  if (gitleaks && !installed(gitleaks)) {
    throw new Error(`a history check runs gitleaks over the same commits, and \`${gitleaks}\` is not installed ` +
      "(brew install gitleaks); nothing was checked");
  }
  const found = new Map();
  const pathOf = new Map();
  for (const line of git(root, ["rev-list", "--objects", ...revisions]).toString("utf8").split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0 && space < line.length - 1 && !pathOf.has(line.slice(0, space))) {
      pathOf.set(line.slice(0, space), line.slice(space + 1));
    }
  }
  const listed = git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    [...pathOf.keys()].join("\n")).toString("utf8");
  const blobs = listed.split("\n").filter((line) => line.endsWith(" blob")).map((line) => line.split(" ")[0]);
  for (const path of new Set(blobs.map((sha) => pathOf.get(sha)))) {
    for (const hit of findHits(path, rules)) record(found, hit.rule, path, "path");
  }
  for await (const { sha, bytes } of readBlobs(root, blobs)) {
    for (const hit of scanBytes(bytes, rules)) record(found, hit.rule, `${pathOf.get(sha)} @${sha.slice(0, 8)}`, describe(hit));
  }
  const log = git(root, ["log", "--format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B%x1e", ...revisions]).toString("utf8");
  for (const entry of log.split("\x1e")) {
    const [sha, author, committer, message] = entry.replace(/^\n/, "").split("\0");
    if (!message && !author) continue;
    const commit = `commit ${sha.slice(0, 8)}`;
    for (const hit of findHits(`${author}\n${committer}`, rules)) record(found, hit.rule, `${commit} identity`, "");
    for (const hit of findHits(message ?? "", rules)) record(found, hit.rule, `${commit} message`, String(hit.line));
  }
  const out = [];
  const byRule = new Map();
  for (const entry of found.values()) {
    if (!byRule.has(entry.rule)) byRule.set(entry.rule, []);
    byRule.get(entry.rule).push(entry.path);
  }
  for (const [rule, places] of byRule) {
    out.push(`public-scan: ${rule}: ${places.length} places`);
    for (const place of places.slice(0, SHOWN_PER_RULE)) out.push(`  ${place}`);
    if (places.length > SHOWN_PER_RULE) out.push(`  and ${places.length - SHOWN_PER_RULE} more`);
  }
  const leaks = gitleaks ? runGitleaks(gitleaks, root, revisions) : [];
  for (const leak of leaks) {
    out.push(`public-scan: gitleaks ${leak.RuleID}  ${leak.File}:${leak.StartLine} @${leak.Commit.slice(0, 8)}`);
  }
  const clean = found.size === 0 && leaks.length === 0;
  out.push(clean
    ? `public-scan: history clean: ${blobs.length} blobs and their commits, ${rules.length} rules`
    : "public-scan: history is not clean; see above");
  return { status: clean ? 0 : 1, out };
}

async function main(argv) {
  const options = { ...DEFAULTS, denylistPath: runtimePaths().publicScanDenylist };
  let result;
  if (argv.length === 0) {
    result = runGate(options);
  } else if (argv.length === 1 && argv[0] === "--update-baseline") {
    result = runGate({ ...options, update: true });
  } else if (argv.length > 1 && argv[0] === "--history") {
    const { rules, denylistFound } = loadRules(options);
    if (!denylistFound) {
      throw new Error(`--history needs the denylist at ${options.denylistPath}; without it no personal rule runs`);
    }
    result = await runHistory({ root: options.root, rules, revisions: argv.slice(1) });
  } else {
    throw new Error("usage: public-scan.mjs [--update-baseline | --history <git rev-list arguments>...]");
  }
  const stream = result.status === 0 ? process.stdout : process.stderr;
  for (const line of result.out) stream.write(`${line}\n`);
  process.exitCode = result.status;
}

if (import.meta.main) await main(process.argv.slice(2));
