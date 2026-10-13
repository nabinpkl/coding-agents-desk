#!/usr/bin/env node
// Reads what the panel recorded about its canvas strips (`<user>-panel-scroll.log`, written by
// `agent-feed/sidecar/src/http/panelScrollRoutes.ts`) against the sidecar's own log, and prints
// every time a strip ended up at its far end without the reader putting it there, with what
// happened in the seconds before: a sidecar restart, a hot update, a reload, a restore, a resize.
//
//   node tools/panel-scroll-report.mjs [--since 2026-10-13T04:00] [--window 8] [--all]
//
// `--all` prints every jump to the end, the reader's own included. Times are the page's clock,
// which is the one a reload or a held batch does not move; restart lines are the sidecar's.

import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { runtimePaths } from "./runtime-paths.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const since = option("--since", "");
const windowMs = Number(option("--window", "8")) * 1000;
const all = args.includes("--all");

const scrollLog = runtimePaths().panelScrollLog;
const sidecarLog = process.env.AGENTDESK_AGENT_FEED_SIDECAR_LOG
  || join("/Users/Shared/agentdesk/logs", `${userInfo().username}-agent-feed-sidecar.log`);

/** One panel line: `<sidecar time> <page time> page=<id> <kind> <json>`. */
function parsePanel(line) {
  const match = /^(\S+) (\S+) page=(\S+) (\S+) (.*)$/.exec(line);
  if (!match) return null;
  let fields = {};
  try {
    fields = JSON.parse(match[5]);
  } catch {
    fields = { raw: match[5] };
  }
  return { at: Date.parse(match[2]), page: match[3], kind: match[4], ...fields };
}

const panel = readFileSync(scrollLog, "utf8").split("\n").map(parsePanel)
  .filter((event) => event && (!since || new Date(event.at).toISOString() >= since))
  .sort((a, b) => a.at - b.at);

const restarts = readFileSync(sidecarLog, "utf8").split("\n")
  .filter((line) => line.includes("[sidecar-supervisor]") && /replacing the sidecar|sidecar started|exited/.test(line))
  .map((line) => ({ at: Date.parse(line.slice(0, 24)), kind: "sidecar", text: line.slice(25, 140) }))
  .filter((event) => Number.isFinite(event.at) && (!since || new Date(event.at).toISOString() >= since));

const time = (at) => new Date(at).toISOString().slice(11, 23);
const describe = (event) => {
  if (event.kind === "sidecar") return event.text;
  const { at, page, kind, ...rest } = event;
  return `${page} ${kind} ${JSON.stringify(rest)}`;
};

// A jump: a strip at its end whose previous resting place, on the same page, was not. The reader's
// own input is not a jump unless --all asks for it.
const resting = new Map();
const jumps = [];
for (const event of panel) {
  if (!event.kind.startsWith("strip.") || event.left === undefined) continue;
  const key = `${event.page} ${event.strip}`;
  const before = resting.get(key);
  // A settle carries no cause of its own; the scroll that led to it is the line that says.
  const judged = event.kind !== "strip.settle" && event.kind !== "strip.attach";
  if (judged && event.atEnd && before && !before.atEnd && (all || !String(event.cause ?? "").startsWith("input:"))) {
    jumps.push({ event, before });
  }
  if (event.kind === "strip.settle" || event.kind === "strip.attach" || event.kind === "strip.restore") {
    resting.set(key, event);
  }
}

console.log(`${panel.length} panel events, ${restarts.length} sidecar restart lines, ${jumps.length} jumps to the end`);
for (const { event, before } of jumps) {
  console.log(`\n=== ${time(event.at)} ${event.strip} on ${event.page}: ${before.left} -> ${event.left} of ${event.max} (${event.kind}, cause ${event.cause ?? "-"})`);
  const context = [...panel, ...restarts]
    .filter((other) => other.at >= event.at - windowMs && other.at <= event.at + 1000)
    .filter((other) => other.kind === "sidecar" || other.page === event.page)
    .sort((a, b) => a.at - b.at);
  for (const other of context) console.log(`  ${time(other.at)} ${describe(other)}`);
}
