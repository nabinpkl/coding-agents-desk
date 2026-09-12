// Putting a turn into a Claude Code session that is already running in someone's terminal.
//
// The obvious route was the process tree: walk a session's pid up to the terminal that owns its
// window and type into it. Measured on this machine, that walk ends at the terminal APPLICATION,
// not a window -- two live sessions in two Ghostty windows share one pid, because Ghostty (like
// Terminal.app and iTerm2) runs every window in one process. What separates them is the tty, and
// mapping a tty back to a window is per-emulator and absent in several. That is why
// `AgentWindowSessionResolver` classifies these chains as `.terminal` and refuses them, and the
// refusal is right.
//
// The harness publishes a better join. Every live session writes `messagingSocketPath` into its
// registry row and an auth key beside it, and accepts newline-delimited JSON on that socket: one
// `auth` line, then one `user` line. So the address of a session is its session id, the way it
// already is everywhere else in this sidecar, and delivery needs no window, no Accessibility, no
// focus, and no terminal it can script. It works the same through tmux and over ssh.
//
// Two things this deliberately does NOT do. It never takes a socket path from a caller -- the path
// comes from a registry row this process verified against the kernel, because a caller-supplied
// path would make this endpoint a write oracle over every unix socket the sidecar can open. And it
// does not claim more than it did: `delivered` means the bytes reached the inbox, not that the
// session accepted the turn (see `CliInputReceipt`).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import type {
  CliInputReceipt,
  CliInputStatus,
  CliInputUnavailableReason,
} from "@agentdesk/agent-feed-wire";
import { config } from "../config.ts";
import type { CommandRunner } from "../tasks/processProbe.ts";
import { currentProcessTable, runCommand } from "../tasks/processProbe.ts";
import { parseRegistryProcStart, startTimesAgree } from "../tasks/processStartTime.ts";
import { sessionOwner, type ClaudeSessionProcess } from "../tasks/sessionRegistry.ts";

/**
 * How long one delivery may take, end to end.
 *
 * Bounded, because what it guards is a connect and a drain into a LOCAL socket, and a session
 * that is deep in a model call still drains one -- the read side is its event loop. Not razor
 * thin, though: the largest allowed turn is bigger than a unix socket's buffer, so a peer that
 * reads in bursts can make the write take several round trips. The cost of getting this wrong in
 * either direction is a phone: too short reports a delivered turn as failed, too long shows a
 * spinner where a dead socket should have said so.
 */
const DELIVERY_TIMEOUT_MS = 5000;

/**
 * The largest turn we will hand to a session.
 *
 * Sized against the two things it has to agree with: the composer's own 100,000-character limit,
 * which is what the window band already allows for the same act of typing into someone else's
 * session, and the relay's 256 KiB body cap, which would otherwise refuse the request before this
 * check ever ran and report it as a transport failure rather than as too much text.
 */
export const MAXIMUM_INPUT_BYTES = 128 * 1024;

/** A verified, addressable inbox: which process, which socket, and how to identify to it. */
export interface InboxTarget {
  owner: ClaudeSessionProcess;
  socketPath: string;
  token: string;
}

/**
 * The key file the harness writes beside the registry row, `<pid>.<sha256(socketPath)>.key`.
 *
 * Derived rather than found by scanning the directory. The hash is over the socket path, so
 * deriving it is what proves the key we read belongs to THIS session's socket; picking whichever
 * key file happens to carry the right pid would hand one session's token to another's inbox after
 * a pid is reused.
 */
export function inboxKeyFileName(pid: number, socketPath: string): string {
  const canonical = resolve(socketPath);
  return `${pid}.${createHash("sha256").update(canonical).digest("hex")}.key`;
}

/**
 * The harness's own wire: one `auth` line, then one `user` line, newline-delimited JSON.
 *
 * `session_id` is the last check, and the only one the RECEIVER makes. Everything else this module
 * verifies -- the registry row's start time, the key file's -- proves the pid is the one we think.
 * None of it covers the socket being rebound by a different session between the read and the
 * write. The harness drops a frame whose `session_id` is not its own, so naming the session is
 * what makes a misdirected turn impossible rather than merely unlikely. The field is optional
 * there, and omitting it means no check at all, which is why it is always sent.
 */
export function encodeInboxPayload(token: string, sessionId: string, text: string): string {
  return [
    JSON.stringify({ type: "auth", token }),
    JSON.stringify({
      type: "user",
      session_id: sessionId,
      message: { role: "user", content: text },
    }),
  ].join("\n") + "\n";
}

/** A peer token is 16 random bytes, hex. Shape-checked so a truncated file is not sent as a token. */
function readToken(text: string, ownerStartedAt: number): string | null {
  let record: { peerToken?: unknown; procStart?: unknown };
  try {
    record = JSON.parse(text) as typeof record;
  } catch {
    return null;
  }
  const { peerToken, procStart } = record;
  if (typeof peerToken !== "string" || !/^[0-9a-f]{32}$/.test(peerToken)) return null;
  // The same pid-reuse defence the registry row gets, for the same reason: this file outlives the
  // process that wrote it, and a token from a dead session addresses whatever now holds its pid.
  if (typeof procStart === "string") {
    const written = parseRegistryProcStart(procStart);
    if (written === null || !startTimesAgree(written, ownerStartedAt)) return null;
  }
  return peerToken;
}

/**
 * A session's inbox, or the reason it has none, keeping the owner either way.
 *
 * The owner is carried on the unavailable arm because the panel needs it: `no-inbox` on a
 * `claude-desktop` session and `no-inbox` on a `cli` one lead to different offers, and asking the
 * registry a second time to find that out would both cost a second scan and answer about a
 * possibly different moment.
 */
export type InboxResolution =
  | { kind: "ready"; target: InboxTarget }
  | {
    kind: "unavailable";
    reason: CliInputUnavailableReason;
    owner: ClaudeSessionProcess | null;
  };

/**
 * The inbox serving one session, or the reason there is none.
 *
 * Every step can fail in a way that is ordinary rather than faulty -- no live process, an older
 * harness with no socket, a key that has been swept -- so each answers with a reason the panel can
 * render, and none of them logs.
 */
export async function resolveInbox(
  sessionId: string,
  run: CommandRunner = runCommand,
  sessionsDirectory: string = config.claudeSessionsDirectory,
): Promise<InboxResolution> {
  const owner = await sessionOwner(sessionId, await currentProcessTable(run), sessionsDirectory);
  if (!owner) return { kind: "unavailable", reason: "not-running", owner: null };
  const unavailable = (reason: CliInputUnavailableReason): InboxResolution =>
    ({ kind: "unavailable", reason, owner });
  if (!owner.messagingSocketPath) return unavailable("no-inbox");
  const socketPath = resolve(owner.messagingSocketPath);
  let keyText: string;
  try {
    keyText = await readFile(
      join(sessionsDirectory, inboxKeyFileName(owner.pid, socketPath)),
      "utf8",
    );
  } catch {
    return unavailable("no-key");
  }
  const token = readToken(keyText, owner.startedAt);
  if (token === null) return unavailable("no-key");
  return { kind: "ready", target: { owner, socketPath, token } };
}

/** Whether this session can be typed into right now, without writing anything to it. */
export async function cliInputStatus(
  sessionId: string,
  run: CommandRunner = runCommand,
  sessionsDirectory?: string,
): Promise<CliInputStatus> {
  const resolved = await resolveInbox(sessionId, run, sessionsDirectory);
  if (resolved.kind === "unavailable") {
    return {
      available: false,
      entrypoint: resolved.owner?.entrypoint ?? null,
      reason: resolved.reason,
      tmuxSession: resolved.owner?.tmuxSession ?? null,
    };
  }
  return {
    available: true,
    entrypoint: resolved.target.owner.entrypoint,
    reason: null,
    tmuxSession: resolved.target.owner.tmuxSession,
  };
}

/**
 * Writes one turn into a session's inbox.
 *
 * Half-close after the payload, then wait for the peer to close. The harness parses on both `data`
 * and `end`, so ending the write side is what tells it the last line is complete; waiting for its
 * close is what distinguishes "the bytes were taken" from "the socket accepted a connect and then
 * nothing".
 */
export async function deliverCliInput(
  sessionId: string,
  text: string,
  run: CommandRunner = runCommand,
  sessionsDirectory?: string,
): Promise<CliInputReceipt> {
  const resolved = await resolveInbox(sessionId, run, sessionsDirectory);
  if (resolved.kind === "unavailable") return { delivered: false, reason: resolved.reason };
  const { socketPath, token, owner } = resolved.target;
  return await writePayload(socketPath, encodeInboxPayload(token, owner.sessionId, text));
}

function writePayload(socketPath: string, payload: string): Promise<CliInputReceipt> {
  return new Promise((resolveWith) => {
    const socket = connect({ path: socketPath });
    let settled = false;
    const settle = (reason: CliInputUnavailableReason | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveWith({ delivered: reason === null, reason });
    };
    socket.setTimeout(DELIVERY_TIMEOUT_MS, () => settle("delivery-failed"));
    // ENOENT and ECONNREFUSED are the stale-socket shapes: the file outlived its listener.
    socket.on("error", (error: NodeJS.ErrnoException) =>
      settle(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "unreachable" : "delivery-failed"));
    socket.on("connect", () => socket.end(payload));
    socket.on("close", (hadError) => settle(hadError ? "delivery-failed" : null));
  });
}
