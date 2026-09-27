// Which runtime spawned this relay child, read from the parent process.
//
// Claude Code starts one stdio child per session, so the parent is the session. opencode starts one
// child per `serve`, which holds every session on the machine, so the parent's command name is the
// only thing that separates the two shapes, and the shape decides whether a session id can be read
// from a parent at all.

import { execFileSync } from "node:child_process";
import type { MessagingSource } from "@agentdesk/agent-feed-wire";

/** The command name of a process, its last path segment: `/opt/homebrew/bin/opencode` is `opencode`. */
export function parentCommand(pid: number): string {
  const text = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const parts = text.split("/");
  return parts[parts.length - 1] ?? "";
}

/** The runtime that spawned this child. Unreadable parents fall back to claude, which then fails on the registry read rather than pretending. */
export function parentRuntime(pid: number = process.ppid): MessagingSource {
  try {
    return parentCommand(pid).startsWith("opencode") ? "opencode" : "claude";
  } catch {
    return "claude";
  }
}
