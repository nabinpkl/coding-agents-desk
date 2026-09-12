// Running tmux, and what it means when tmux is not there.
//
// One spawn helper for the whole terminal path, so a missing binary is one error with one
// message rather than a different silence per caller.

import { config } from "@/config";

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

export function demand(what: string, result: { err: string; code: number }): void {
  if (result.code === 0) return;
  throw new TmuxUnavailable(`tmux ${what} read exited ${result.code}: ${result.err.trim()}`);
}
