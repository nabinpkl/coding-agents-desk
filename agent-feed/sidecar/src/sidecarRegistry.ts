import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type {
  SupervisorCommand,
  SupervisorMode,
  SupervisorStatus,
} from "@agentdesk/agent-feed-wire";
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
    mode: raw.mode === "manual" ? "manual" : "auto",
  };
}

// ---------------------------------------------------------------------------
// The other direction, which is the only one there is
//
// The supervisor is the sidecar's PARENT. It has no port, nothing listens on its behalf, and the
// panel that wants to tell it something is often on another machine entirely. So the request goes
// where the state already comes from: the sidecar writes it onto the board on the panel's behalf,
// and the supervisor picks it up. One file, overwritten, rather than a queue -- the mode is a level
// and the only edge is "take it now", which is carried as a stamp the supervisor compares.

/** What the panel has asked of this machine's supervisor. */
export interface SupervisorRequest {
  /** The mode it should be in. */
  readonly mode: SupervisorMode;
  /** When the reader last asked it to take the tree. 0 when they never have. */
  readonly apply: number;
}

const NOTHING_ASKED: SupervisorRequest = { mode: "auto", apply: 0 };

/** `<registry>/<user>.supervisor.request.json`, beside the state it is answering. */
export function supervisorRequestPath(dir = runtimePaths().sidecarRegistry): string {
  return join(dir, `${userInfo().username}.supervisor.request.json`);
}

/**
 * Record what the reader asked for, and answer with the standing request as it now reads.
 *
 * Merged rather than replaced, because the two halves are independent: choosing a mode must not
 * forget that they pressed apply a moment ago, and pressing apply must not put them back on auto.
 */
export function requestSupervisor(command: SupervisorCommand, dir?: string): SupervisorRequest {
  const current = readSupervisorRequest(dir);
  const next: SupervisorRequest = command === "apply"
    ? { ...current, apply: Date.now() }
    : { ...current, mode: command };
  const file = supervisorRequestPath(dir);
  ensureCrossSessionDirectory(dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(next));
  renameSync(temporary, file);
  return next;
}

/**
 * The standing request, or nothing asked.
 *
 * Not aged out, unlike the descriptor: this is a standing preference rather than a heartbeat, and a
 * request that expired on a timer would put the sidecar back to restarting under a reader who had
 * simply not touched the control for a while. What ends it is the supervisor starting again, which
 * clears the file itself.
 */
export function readSupervisorRequest(dir?: string): SupervisorRequest {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(supervisorRequestPath(dir), "utf8")) as Record<string, unknown>;
  } catch {
    return NOTHING_ASKED;
  }
  return {
    mode: raw.mode === "manual" ? "manual" : "auto",
    apply: typeof raw.apply === "number" ? raw.apply : 0,
  };
}

/**
 * Forget what was asked, which a starting supervisor does before it reads anything.
 *
 * A fresh supervisor is a fresh decision: the panel's own mode resets when its dev server restarts,
 * and a file left over from yesterday silently freezing this machine's sidecar is the failure that
 * would be hardest to see.
 */
export function clearSupervisorRequest(dir?: string): void {
  try {
    rmSync(supervisorRequestPath(dir), { force: true });
  } catch {
    // Nothing read it yet either way; the supervisor's own mode is what decides.
  }
}
