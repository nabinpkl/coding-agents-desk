// Where the reader's choice about live updates outlives the process that serves them.
//
// It used to live only in the dev server's memory, on the reasoning that a fresh process should be
// a fresh decision, and that a manual left over from yesterday would silently freeze the panel with
// nobody to say so. Half of that was wrong by the time it was written: the Profile strip says
// `updates manual` whenever it is in force, at rest, with nothing waiting, so the state is not
// silent and has not been since the control shipped. What was left was a deliberate choice being
// discarded by a restart the reader did not ask for -- and a dev server restart is one of the
// things they are asking to be protected from when they choose to hold updates in the first place.
//
// Only the panel's own mode is kept here. Each machine's supervisor still starts on auto and is
// told again by `panelPublish`'s reconcile within a couple of seconds, so a machine whose panel is
// gone runs normally rather than staying frozen on the word of a process that is no longer there.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type UpdateMode = "auto" | "manual";

/** What the reader last chose, or the ordinary loop when they never have. */
export function readPublishMode(file: string): UpdateMode {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { mode?: unknown };
    return raw.mode === "manual" ? "manual" : "auto";
  } catch {
    // No file, half a file, a hand-edited one. All three mean nobody has asked for anything, and
    // starting a dev server is a bad moment to refuse over a preference.
    return "auto";
  }
}

/** Remember it, best effort: losing the preference is not worth failing a mode change over. */
export function writePublishMode(file: string, mode: UpdateMode): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ mode }));
  } catch {
    // The mode still applies to this server for as long as it runs; only the memory of it is lost.
  }
}
