// Which sidecar on this machine sends the notifications it raises on its own.
//
// Every sidecar this user runs reads the same transcripts and the same `web-push.json`, so a dev
// sidecar beside a stable one would each see a turn finish and each push it: every notification
// twice. The first to ask holds a lease file naming its pid; a holder whose process is gone is
// taken over, so a sidecar restarted by a save simply takes it back.

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else, which still means it is alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function claim(path: string, pid: number): boolean {
  try {
    writeFileSync(path, `${pid}\n`, { flag: "wx", mode: 0o600 });
    process.once("exit", () => {
      try {
        if (Number.parseInt(readFileSync(path, "utf8"), 10) === pid) unlinkSync(path);
      } catch {
        // Gone already, or taken over: either way it is no longer ours to remove.
      }
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Whether this process is the one that sends, taking the lease if it is free or its holder died. */
export function holdsSenderLease(path: string, pid: number = process.pid): boolean {
  if (claim(path, pid)) return true;
  const holder = Number.parseInt(readFileSync(path, "utf8"), 10);
  if (holder === pid) return true;
  if (Number.isSafeInteger(holder) && isAlive(holder)) return false;
  unlinkSync(path);
  return claim(path, pid);
}
