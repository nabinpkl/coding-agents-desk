#!/usr/bin/env node
// Reads this repository's history and writes the JSON the timeline page renders.
//
// Two `git log` passes rather than one: the first carries the message, the second the line counts,
// and keeping them apart means a commit body containing a tab or a newline cannot shift a number.
// Merge commits are excluded. A merge has no diff of its own and the branch landings are already
// in the history they joined, so counting them would inflate the timeline without adding work.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { BUILD_DIR, DATA_FILE, REPO_ROOT } from "./config.mjs";

const FIELD = "\x1f";
const RECORD = "\x00";

const git = (...args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1 << 30 });

// A conventional-commit prefix is the one classification this history already carries, so the
// timeline reads it rather than inventing a taxonomy. No prefix means "other", not an error.
// `family` folds rare prefixes into "other" for the filter row: the tag still shows what the
// author actually wrote, while the chips stay a countable set instead of sixteen one-offs.
const PREFIX = /^([a-z][a-z-]*)(?:\(([^()\s]+)\))?!?:/;
const FILTERABLE = new Set(["feat", "fix", "docs", "refactor", "chore", "test", "perf", "build", "style"]);

function classify(subject) {
  const match = PREFIX.exec(subject);
  if (!match) return { kind: "other", family: "other", scope: "", title: subject };
  const [, kind, scope = ""] = match;
  return {
    kind,
    family: FILTERABLE.has(kind) ? kind : "other",
    scope,
    title: subject.slice(match[0].length).trim(),
  };
}

const messages = git("log", "--no-merges", `--format=${["%H", "%h", "%an", "%aI", "%s", "%D", "%b"].join("%x1f")}%x00`);

const commits = [];
for (const record of messages.split(RECORD)) {
  // git separates commits with a newline after each record, so every record but the first opens
  // with one; the trailing record is that separator alone, not a commit.
  const clean = record.replace(/^\n+/, "");
  if (!clean) continue;
  const [hash, short, author, isoDate, subject, decoration, body] = clean.split(FIELD);
  if (!/^[0-9a-f]{40}$/.test(hash)) {
    // The only non-record git emits is the newline after the last one. Anything else means the
    // parse is misaligned, and skipping it would quietly shorten the history.
    throw new Error(`unexpected git log record: ${JSON.stringify(clean.slice(0, 80))}`);
  }
  const { kind, family, scope, title } = classify(subject);
  commits.push({
    hash,
    short,
    author,
    date: isoDate,
    subject,
    title,
    kind,
    family,
    scope,
    refs: decoration
      ? decoration
          .split(",")
          .map((ref) => ref.trim())
          .filter(Boolean)
      : [],
    body: (body ?? "").trim(),
    files: 0,
    additions: 0,
    deletions: 0,
  });
}

// `--numstat` follows each commit's header line with `added\tdeleted\tpath`, and `-` for a binary
// file. Paths are ignored: only the magnitude of the change is being plotted. Keyed by the full
// hash, not the abbreviation: two commits sharing a short sha would land on one entry.
const numstat = git("log", "--no-merges", "--numstat", "--format=%x00%H");
const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
for (const chunk of numstat.split(RECORD)) {
  const lines = chunk.split("\n");
  const target = byHash.get(lines[0]?.trim());
  if (!target) continue;
  for (const line of lines.slice(1)) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!match) continue;
    target.files += 1;
    target.additions += Number(match[1]) || 0;
    target.deletions += Number(match[2]) || 0;
  }
}

let head = "";
let branch = "";
try {
  head = git("rev-parse", "--short", "HEAD").trim();
  branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
} catch {
  // A repository with no commits still gets a page that says so.
}

// The ends of the timeline come from the dates themselves: `git log`'s order is commit order, and a
// rebase can leave an author date earlier than its ancestor's.
const dated = commits.map((commit) => ({ iso: commit.date, ms: Date.parse(commit.date) })).sort((a, b) => a.ms - b.ms);

const data = {
  repo: basename(REPO_ROOT),
  head,
  branch,
  generatedAt: new Date().toISOString(),
  total: commits.length,
  first: dated[0]?.iso ?? null,
  last: dated.at(-1)?.iso ?? null,
  commits,
};

const json = JSON.stringify(data);
mkdirSync(BUILD_DIR, { recursive: true });
writeFileSync(DATA_FILE, json);

const megabytes = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
console.error(`commits-timeline: ${data.total} commits -> ${DATA_FILE} (${megabytes} MB)`);
