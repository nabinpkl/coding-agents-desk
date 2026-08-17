/**
 * Canary for the three undocumented harness artifacts background-task detection stands on.
 *
 * ADR-0099 accepts a real risk: the session registry at `~/.claude/sessions/<pid>.json`, the
 * `<session>/tasks/<task-id>.output` layout, and the `[exited with code N]` / `[killed]` marker
 * text are all things a Claude Code release can move. When one moves, the feature does not throw
 * -- it reports that nothing is running, which is indistinguishable from a quiet machine and is
 * therefore the one failure nobody notices.
 *
 * So this fails LOUDLY on each of them, by checking the contract rather than the weather:
 * "a Claude process is running but the registry resolves none" is a broken registry, where
 * "no tasks are running" is just a quiet moment and is not an error.
 *
 * Run: just agent-feed-background-tasks-smoke
 */

import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "../src/config.ts";
import { backgroundTaskSnapshot } from "../src/tasks/backgroundTasks.ts";
import { outputTargetsOf, runCommand, taskShellsOf } from "../src/tasks/processProbe.ts";
import { liveSessionProcesses } from "../src/tasks/sessionRegistry.ts";
import { claudeTranscriptPath, readBackwardWindow, scanSessionTasks } from "../src/tasks/taskIdentity.ts";
import { parseTerminalMarker } from "../src/tasks/taskState.ts";

const failures: string[] = [];
const notes: string[] = [];

function fail(contract: string, detail: string): void {
  failures.push(`${contract}: ${detail}`);
}

// ---------------------------------------------------------------------------
// 1. The session registry still names live processes.
// ---------------------------------------------------------------------------
const claudePids = (await runCommand(["pgrep", "-f", "claude-code|claude.app|/claude$"]))
  .split(/\s+/)
  .filter(Boolean);
const live = await liveSessionProcesses();

console.log(`live sessions from the registry: ${live.length}`);
for (const session of live) {
  console.log(`  pid ${session.pid}  ${session.sessionId}  ${session.cwd}`);
}

if (live.length === 0) {
  if (claudePids.length > 0) {
    fail(
      "session-registry",
      `${claudePids.length} Claude processes are running but ${config.claudeSessionsDirectory} resolved none. ` +
        "Either the registry moved, its record shape changed, or procStart is no longer UTC.",
    );
  } else {
    notes.push("no Claude process was running, so the registry could not be exercised");
  }
}

// ---------------------------------------------------------------------------
// 2. The start record still reads the way the adapter parses it.
// ---------------------------------------------------------------------------
let scannedTranscripts = 0;
let startsFound = 0;
let startPhrasePresent = false;

for (const session of live) {
  const transcriptPath = await claudeTranscriptPath(session.sessionId);
  if (!transcriptPath) {
    notes.push(`no transcript found for ${session.sessionId}`);
    continue;
  }
  scannedTranscripts += 1;
  const window = await readBackwardWindow(transcriptPath, 4 * 1024 * 1024);
  if (window.text.includes("Command running in background with ID")) startPhrasePresent = true;
  const scan = await scanSessionTasks(session.sessionId, transcriptPath, new Set());
  startsFound += scan.starts.size;
}

if (startPhrasePresent && startsFound === 0) {
  fail(
    "start-record",
    "a transcript contains 'Command running in background with ID' but the adapter parsed no starts. " +
      "The wording or the output-path shape changed.",
  );
}
if (!startPhrasePresent) {
  notes.push("no recent transcript mentioned a background start, so the start record was not exercised");
}

// ---------------------------------------------------------------------------
// 3. The task-output layout still holds, and the terminal marker still parses.
// ---------------------------------------------------------------------------
let captureFilesSeen = 0;
let markersParsed = 0;
let unparseableTails = 0;

try {
  for (const slug of await readdir(config.claudeTaskRoot)) {
    for (const session of live) {
      const directory = join(config.claudeTaskRoot, slug, session.sessionId, "tasks");
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".output")) continue;
        const path = join(directory, name);
        const size = (await stat(path)).size;
        if (size === 0) continue;
        captureFilesSeen += 1;
        const file = Bun.file(path);
        const tail = await file.slice(Math.max(0, size - 256), size).text();
        if (parseTerminalMarker(tail)) markersParsed += 1;
        else unparseableTails += 1;
      }
    }
  }
} catch (error) {
  fail("task-output-root", `${config.claudeTaskRoot} could not be read: ${String(error)}`);
}

console.log(`capture files with content: ${captureFilesSeen} (markers parsed: ${markersParsed})`);
if (captureFilesSeen > 0 && markersParsed === 0) {
  fail(
    "terminal-marker",
    `${captureFilesSeen} capture files had content and none ended in a marker this build recognises. ` +
      "The '[exited with code N]' / '[killed]' text changed.",
  );
}
if (unparseableTails > 0 && markersParsed > 0) {
  // Expected: the still-running ones have no marker yet.
  notes.push(`${unparseableTails} capture files had no terminal marker (running, or truncated)`);
}

// ---------------------------------------------------------------------------
// 4. What is running right now, and can its real output be followed.
// ---------------------------------------------------------------------------
for (const session of live) {
  const snapshot = await backgroundTaskSnapshot(session.sessionId);
  if (snapshot.running.length === 0 && snapshot.finished.length === 0) continue;
  console.log(`\n${session.sessionId}  (${basename(session.cwd)})`);
  console.log(`  running ${snapshot.running.length} | finished ${snapshot.finished.length}`);
  for (const task of snapshot.running) {
    console.log(
      `  ${task.corroborated ? "●" : "○"} ${task.taskId}  ${Math.round(task.elapsedMs / 1000)}s  ` +
        `hasOutput=${task.hasOutput}  ${task.description.slice(0, 56)}`,
    );
    if (!task.corroborated) {
      // A live shell the transcript says nothing about: promoted to the background after it
      // started, or an ordinary foreground command that has run past the threshold. The smoke
      // cannot tell which either, and saying so is the point.
      console.log("     uncorroborated -- shown on elapsed time alone, description is the argv");
    }
    const shell = (await taskShellsOf(runCommand, session.pid)).find((s) => s.taskId === task.taskId);
    if (!shell) continue;
    const targets = await outputTargetsOf(runCommand, shell);
    const target = targets[0] ?? shell.capturePath;
    const size = (await stat(target).catch(() => ({ size: -1 }))).size;
    console.log(`     streaming from ${basename(target)} (${size} bytes)`);
    if (targets.length > 0 && !task.hasOutput) {
      console.log("     capture is empty because the command redirected -- resolved from its own fds");
    }
  }
  for (const task of snapshot.finished.slice(0, 4)) {
    console.log(`  ○ ${task.taskId}  ${JSON.stringify(task.state)}  ${task.description.slice(0, 48)}`);
  }
}

// ---------------------------------------------------------------------------

console.log("");
for (const note of notes) console.log(`note: ${note}`);
if (failures.length > 0) {
  console.error("\nbackground-task detection has drifted from the harness:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`contracts held (${scannedTranscripts} transcripts scanned)`);
