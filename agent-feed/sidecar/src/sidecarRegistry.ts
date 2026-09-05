import { renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { runtimePaths } from "../../../tools/runtime-paths.mjs";
import { ensureCrossSessionDirectory } from "./crossSessionDirectory.ts";

/** How often the descriptor's heartbeat is refreshed. A reader ages entries out at three misses. */
const HEARTBEAT_MS = 5_000;

/** The shape written to `<registry>/<user>.json`. Read side lives in the panel's dev server. */
export interface SidecarDescriptor {
  readonly user: string;
  readonly label: string;
  readonly port: number;
  readonly pid: number;
  readonly startedAt: number;
  readonly heartbeat: number;
}

export interface SidecarAnnouncement {
  stop(): void;
}

/**
 * Announce this sidecar on the shared rendezvous board so any panel on the machine finds it without
 * being told a port. One file per login session, named by the account, refreshed on a heartbeat.
 *
 * The heartbeat, not a pid check, is how a reader tells a live sidecar from a crashed one: dev and
 * agent are different users, so a panel in one session cannot `kill -0` a pid in the other to test
 * it. Age is the only cross-session liveness signal, and a clock shared by one machine makes it a
 * reliable one.
 *
 * The board is sticky-world-writable (1777, like /Users/Shared itself), so each session owns and can
 * replace only its own file. A file left by an unclean exit is harmless: the reader drops it by age,
 * and the next start by that account overwrites it. The write is a temp-then-rename so a reader
 * never catches a half-written descriptor.
 */
export function announceSidecar(port: number, options?: { dir?: string; label?: string }): SidecarAnnouncement {
  const dir = options?.dir ?? runtimePaths().sidecarRegistry;
  const user = userInfo().username;
  const label = options?.label ?? user;
  const file = join(dir, `${user}.json`);
  const startedAt = Date.now();

  ensureCrossSessionDirectory(dir);

  const write = () => {
    const descriptor: SidecarDescriptor = { user, label, port, pid: process.pid, startedAt, heartbeat: Date.now() };
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(descriptor));
    renameSync(temporary, file);
  };
  write();

  const timer = setInterval(write, HEARTBEAT_MS);
  // Unreferenced so a lingering heartbeat never keeps the process alive on its own.
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
      // Best effort: withdrawing is a courtesy that makes the session vanish immediately instead of
      // aging out, and a failure to remove our own file is not worth crashing a shutdown over.
      try {
        rmSync(file, { force: true });
      } catch {
        // aged out by the reader instead
      }
    },
  };
}
