import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { SupervisorStatus } from "@agentdesk/agent-feed-wire";
import { runtimePaths } from "@repo/tools/runtime-paths.mjs";
import { ensureCrossSessionDirectory } from "@/crossSessionDirectory";

/** How often the descriptor's heartbeat is refreshed. A reader ages entries out at three misses. */
const HEARTBEAT_MS = 5_000;

/** The shape written to `<registry>/<user>.json`. Read side lives in the panel's dev server. */
export interface SidecarDescriptor {
  readonly user: string;
  readonly label: string;
  /**
   * The address a reader should dial, not always loopback.
   *
   * Every peer on this board is another login session on this machine, so this is `127.0.0.1` in
   * practice. It is written down anyway because the reader now also serves peers that are NOT on
   * the board -- another machine cannot write into a directory on this one -- and a reader that
   * assumed loopback for board entries would have to special-case which kind it was looking at.
   */
  readonly host: string;
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
export function announceSidecar(
  port: number,
  options?: { dir?: string; label?: string; host?: string },
): SidecarAnnouncement {
  const dir = options?.dir ?? runtimePaths().sidecarRegistry;
  const user = userInfo().username;
  const label = options?.label ?? user;
  // Loopback unless told otherwise: a board peer is another session on this machine, and a sidecar
  // bound to a wider address is not made reachable by claiming one it is not listening on.
  const host = options?.host ?? "127.0.0.1";
  const file = join(dir, `${user}.json`);
  const startedAt = Date.now();

  ensureCrossSessionDirectory(dir);

  const write = () => {
    const descriptor: SidecarDescriptor = {
      user, label, host, port, pid: process.pid, startedAt, heartbeat: Date.now(),
    };
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

// ---------------------------------------------------------------------------
// The supervisor's own descriptor, on the same board and by the same rules
//
// Two processes need the shape of this file and they are not the same process: the supervisor
// writes it (it is the only one that knows), and the sidecar reads it back to answer `/api/config`
// for a panel that may be on another machine and cannot see the file at all. One home for both, so
// the reader cannot drift from the writer.

/** How stale a supervisor descriptor may be before it reads as no supervisor at all. */
const SUPERVISOR_STALE_MS = HEARTBEAT_MS * 3;

/** `<registry>/<user>.supervisor.json`, beside the sidecar descriptor this user already writes. */
export function supervisorDescriptorPath(dir = runtimePaths().sidecarRegistry): string {
  return join(dir, `${userInfo().username}.supervisor.json`);
}

/**
 * Publish what the supervisor is holding, atomically and with a heartbeat.
 *
 * Temp-then-rename for the reason the sidecar descriptor uses it: a reader must never catch this
 * half written. The heartbeat is what lets a reader tell a supervisor that is thinking from one
 * that died, which a file alone cannot say.
 */
export function writeSupervisorDescriptor(status: SupervisorStatus, dir?: string): void {
  const file = supervisorDescriptorPath(dir);
  ensureCrossSessionDirectory(dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...status, pid: process.pid, heartbeat: Date.now() }));
  renameSync(temporary, file);
}

/** Take it back off the board, so a stopped supervisor vanishes now rather than aging out. */
export function clearSupervisorDescriptor(dir?: string): void {
  try {
    rmSync(supervisorDescriptorPath(dir), { force: true });
  } catch {
    // aged out by the reader instead
  }
}

/**
 * What this machine's supervisor is holding, or null when nothing live is supervising.
 *
 * Null covers three cases a reader cannot tell apart and does not need to: no supervisor was ever
 * started, the file is malformed, and the supervisor stopped heartbeating. All three mean the same
 * thing to whoever is looking at the panel -- nobody is holding anything back on this machine's
 * behalf that they can be told about.
 */
export function readSupervisorDescriptor(dir?: string, now = Date.now()): SupervisorStatus | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(supervisorDescriptorPath(dir), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const heartbeat = typeof raw.heartbeat === "number" ? raw.heartbeat : 0;
  if (now - heartbeat > SUPERVISOR_STALE_MS) return null;
  return {
    held: raw.held === true,
    blocked: typeof raw.blocked === "string" ? raw.blocked : null,
  };
}
