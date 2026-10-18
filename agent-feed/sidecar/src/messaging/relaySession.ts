// Which Claude Code session this relay child serves, and whether that session loaded it as a channel.
//
// Claude Code starts one stdio child per MCP server per session, so the parent process IS the
// session. Its registry row (`~/.claude/sessions/<pid>.json`) names the session, and its argv says
// whether it was started with this server as a development channel. Claude Code never tells a
// server that it was registered as a channel, and without that flag it silently drops every
// channel notification, so the argv is the only honest answer to "will a push reach anyone".

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseRegistryProcStart, startTimesAgree, parseProcessLstart } from "@/tasks/processStartTime";

export const RELAY_SERVER_NAME = "agentdesk-relay";
export const CHANNEL_FLAG = "--dangerously-load-development-channels";
/** The mod that holds a session's hub stream itself (`agent-feed/sidecar/mods/agentdesk-hub`). */
export const HUB_MOD_NAME = "agentdesk-hub";
const PLUGIN_DIR_FLAG = "--plugin-dir";

export interface RelaySession {
  pid: number;
  sessionId: string;
  cwd: string;
  title: string;
  /** Whether the session was started with this server as a channel. */
  channel: boolean;
  /**
   * Whether the session loaded the `agentdesk-hub` mod, whose reader holds the session's hub
   * stream. The hub keeps one stream per session, so a relay child that opened its own would
   * replace the reader's and the two would knock each other off; it keeps its tools and no stream.
   */
  hubMod?: boolean;
}

/**
 * Whether an argv loads `server:<name>` as a development channel.
 *
 * The flag takes the entries that follow it up to the next option, space separated, as the CLI
 * parses them.
 */
export function argvLoadsChannel(argv: readonly string[], name: string = RELAY_SERVER_NAME): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let entries: string[] = [];
    if (arg === CHANNEL_FLAG) {
      for (let j = i + 1; j < argv.length && !argv[j]!.startsWith("-"); j++) entries.push(argv[j]!);
    } else if (arg.startsWith(`${CHANNEL_FLAG}=`)) {
      entries = arg.slice(CHANNEL_FLAG.length + 1).split(/[\s,]+/);
    }
    if (entries.includes(`server:${name}`)) return true;
  }
  return false;
}

/** Whether an argv loads a plugin directory named `agentdesk-hub`, the way `--plugin-dir` takes one. */
export function argvLoadsHubMod(argv: readonly string[]): boolean {
  const named = (path: string | undefined) => path !== undefined && path.replace(/\/+$/, "").split("/").pop() === HUB_MOD_NAME;
  return argv.some((arg, i) => (arg === PLUGIN_DIR_FLAG && named(argv[i + 1])) || (arg.startsWith(`${PLUGIN_DIR_FLAG}=`) && named(arg.slice(PLUGIN_DIR_FLAG.length + 1))));
}

/** The argv of a process, split on whitespace (`ps` joins it; entries here never contain spaces). */
function processArgv(pid: number): string[] {
  const text = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  return text.trim().split(/\s+/);
}

function argvFlags(argv: readonly string[]): { channel: boolean; hubMod: boolean } {
  return { channel: argvLoadsChannel(argv), hubMod: argvLoadsHubMod(argv) };
}

function processLstart(pid: number): number | null {
  const text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  return parseProcessLstart(text.trim());
}

/**
 * The session behind a parent pid, or a sentence saying why there is none.
 *
 * Re-read on a timer by the caller, because the registry row changes when the owner runs /clear or
 * resumes another session in the same process.
 */
export function readRelaySession(
  pid: number = process.ppid,
  directory: string = join(homedir(), ".claude", "sessions"),
): RelaySession | string {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(readFileSync(join(directory, `${pid}.json`), "utf8")) as Record<string, unknown>;
  } catch {
    return `parent process ${pid} is not a Claude Code session (no registry row)`;
  }
  if (typeof record.sessionId !== "string" || typeof record.procStart !== "string") {
    return `registry row for ${pid} has no sessionId`;
  }
  const registryStart = parseRegistryProcStart(record.procStart);
  const kernelStart = processLstart(pid);
  if (registryStart === null || kernelStart === null || !startTimesAgree(registryStart, kernelStart)) {
    return `registry row for ${pid} belongs to an earlier process`;
  }
  return {
    pid,
    sessionId: record.sessionId,
    cwd: typeof record.cwd === "string" ? record.cwd : "",
    title: typeof record.name === "string" ? record.name : "",
    ...argvFlags(processArgv(pid)),
  };
}
