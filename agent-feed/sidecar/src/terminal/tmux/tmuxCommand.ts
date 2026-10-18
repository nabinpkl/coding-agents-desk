// Running tmux, and what it means when tmux is not there.
//
// One spawn helper for the whole terminal path, so a missing binary is one error with one
// message rather than a different silence per caller.

import { config } from "@/config/config";

export class TmuxUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmuxUnavailable";
  }
}

export async function tmux(args: string[]): Promise<{ out: string; err: string; code: number }> {
  const bin = config.tmuxPath;
  if (!bin) {
    throw new TmuxUnavailable("no tmux binary found; set AGENT_FEED_TMUX_PATH to an absolute path");
  }
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

/**
 * Whether a failed tmux command failed only because no server is running, which is not a failure.
 *
 * tmux has TWO wordings for it, and which one arrives is decided by whether the socket FILE is
 * still on disk. Measured on 3.6b, one machine, a second apart:
 *
 *     socket present, nobody listening
 *       no server running on /private/tmp/tmux-501/default
 *     socket absent
 *       error connecting to /private/tmp/tmux-501/default (No such file or directory)
 *
 * Only the first was matched here, and the second is the one a restarted Mac produces. The socket
 * lives under `TMUX_TMPDIR` or `/tmp` -- tmux(1) under `-L`, and never `$TMPDIR`, which on macOS
 * is the per-boot directory under /var/folders -- and macOS empties /private/tmp at boot. So after
 * every restart the file was gone, every tmux question answered `tmux-unavailable`, and the
 * terminal surface read as broken on a machine where nothing was wrong.
 *
 * The `has-session` that `open()` asks before creating a session is on this path too, which is
 * why "tmux starts its own server" did not rescue it: `new-session` does start one, and the check
 * in front of it threw before anything got that far.
 */
export function noServerRunning(output: string): boolean {
  return /no server running|no sessions|error connecting to .+ \(No such file or directory\)/i.test(output);
}

/**
 * Whether tmux is running and that session is not.
 *
 * A separate question from `noServerRunning` because the answers differ: nothing to attach to
 * either way, but only this one says the machine is fine.
 */
export function noSuchSession(output: string): boolean {
  return /can.t find session|no such session|session not found/i.test(output);
}

export function demand(what: string, result: { err: string; code: number }): void {
  if (result.code === 0) return;
  throw new TmuxUnavailable(`tmux ${what} read exited ${result.code}: ${result.err.trim()}`);
}
