// Which agent log a Bot's session keeps (ADR-0147): stated by the session, stored on its Bot.
//
// The session says it rather than the sidecar working it out. A log is appended by whatever the
// agent reaches for, Bash as often as an edit tool, so no reading of its transcript would see every
// write; and a tie made by a commit would need git, a hook and a commit before anything showed.
// What the session states is checked, not trusted: the path has to be a `.log` under
// `.agents/agents-log/`, and has to be a file inside the directory the session works in, so a
// registration cannot point the card's viewer anywhere else.

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import type { BotRecord, BotSessionRef } from "@agentdesk/agent-feed-wire";
import type { BotStore, StoredBotSnapshot } from "@/bots/botStore";
import { sessionKey } from "@/bots/botIdempotency";
import { BotConflictError, BotInvalidError, BotNotFoundError, type BotRegistryCatalog } from "@/bots/botTypes";

/** Where every agent log lives, relative to the directory its session works in. */
export const AGENT_LOG_DIRECTORY = ".agents/agents-log/";
const MAX_LOG_PATH = 256;

/** What a registration did: `already` when the session had stated this same log before. */
export interface RegisteredSessionLog {
  botId: string;
  path: string;
  status: "registered" | "already";
}

/**
 * Whether a stored or requested path has the one shape a log may have.
 *
 * Relative and `/`-separated with no empty, `.` or `..` segment, so it can only name something
 * below the directory it is read against; and under the log directory with a `.log` name, so a
 * session cannot register some other file as its log.
 */
export function isAgentLogPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LOG_PATH) return false;
  if (isAbsolute(value) || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return false;
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return (
    value.startsWith(AGENT_LOG_DIRECTORY) && value.endsWith(".log") && value.length > AGENT_LOG_DIRECTORY.length + 4
  );
}

/** The request body's path, or the reason it is not one. */
export function normalizeLogPath(value: unknown): string {
  if (typeof value !== "string") throw new BotInvalidError("path must be a string");
  const path = value.trim();
  if (!isAgentLogPath(path)) {
    throw new BotInvalidError(
      `path must be a relative "${AGENT_LOG_DIRECTORY}<name>.log" with no "." or ".." segments, at most ${MAX_LOG_PATH} characters`,
    );
  }
  return path;
}

/** The one Bot holding this session, refusing none and refusing two: a relative path needs one root. */
function soleHolder(bots: readonly BotRecord[], key: string): BotRecord {
  const holders = bots.filter((bot) => bot.sessionRefs.some((ref) => sessionKey(ref) === key));
  if (holders.length === 0) throw new BotNotFoundError(`session ${key} is not attached to any Bot`);
  if (holders.length > 1) {
    throw new BotConflictError(
      `session ${key} is held by ${holders.map((bot) => `"${bot.name}"`).join(" and ")}, so no one directory roots its log`,
    );
  }
  return holders[0]!;
}

/** Whether `path` is a file inside `root`, after both are resolved, so a symlink cannot lead out. */
async function fileInside(root: string, path: string): Promise<boolean> {
  try {
    const realRoot = await realpath(root);
    const realFile = await realpath(join(realRoot, path));
    if (!realFile.startsWith(realRoot + sep)) return false;
    return (await stat(realFile)).isFile();
  } catch {
    return false;
  }
}

/**
 * Records `path` as the log this session keeps, replacing any it stated before.
 *
 * The file is looked for where the session works (the catalog's project path, which is its worktree
 * when it has one) and in the Bot's directory, because those are the two roots the card's viewer
 * reads from. Stating the same path again writes nothing, so a session may call this after every
 * line it appends, and one call that missed the sidecar is made good by the next.
 */
export async function registerSessionLog(
  store: BotStore,
  catalog: BotRegistryCatalog,
  ref: BotSessionRef,
  path: string,
): Promise<RegisteredSessionLog> {
  const key = sessionKey(ref);
  const holder = soleHolder((await store.snapshot()).bots, key);
  const roots = [...new Set([catalog.resolveSession(ref)?.projectPath, holder.environment.path])].filter(
    (root): root is string => typeof root === "string",
  );
  let found = false;
  for (const root of roots) {
    if (await fileInside(root, path)) {
      found = true;
      break;
    }
  }
  if (!found) throw new BotNotFoundError(`no file "${path}" where session ${key} works`);
  if (holder.sessionLogs?.[key] === path) return { botId: holder.botId, path, status: "already" };

  return store.mutate<RegisteredSessionLog>((snapshot) => {
    const bot = soleHolder(snapshot.bots, key);
    if (bot.sessionLogs?.[key] === path) return { snapshot, value: { botId: bot.botId, path, status: "already" } };
    return {
      snapshot: withSessionLogs(snapshot, bot.botId, { ...bot.sessionLogs, [key]: path }),
      value: { botId: bot.botId, path, status: "registered" },
    };
  });
}

/**
 * Gives a handover's successor the log its predecessor kept, on every Bot that recorded one.
 *
 * By session rather than by Bot, because only one direction of a handover attaches its successor
 * inside the request; the other is attached by the panel's next call. An entry written ahead of
 * that attach is harmless, since entries outlive detaching anyway, and it is there when the card is.
 */
export async function carrySessionLog(store: BotStore, from: BotSessionRef, to: BotSessionRef): Promise<void> {
  const fromKey = sessionKey(from);
  const toKey = sessionKey(to);
  const carries = (bot: BotRecord) => {
    const path = bot.sessionLogs?.[fromKey];
    return path !== undefined && bot.sessionLogs?.[toKey] !== path;
  };
  if (!(await store.snapshot()).bots.some(carries)) return;
  await store.mutate((snapshot) => {
    let next = snapshot;
    for (const bot of snapshot.bots) {
      if (!carries(bot)) continue;
      next = withSessionLogs(next, bot.botId, { ...bot.sessionLogs, [toKey]: bot.sessionLogs![fromKey]! });
    }
    return { snapshot: next, value: undefined };
  });
}

function withSessionLogs(
  snapshot: StoredBotSnapshot,
  botId: string,
  sessionLogs: Record<string, string>,
): StoredBotSnapshot {
  return {
    ...snapshot,
    revision: snapshot.revision + 1,
    bots: snapshot.bots.map((bot) => (bot.botId === botId ? { ...bot, sessionLogs } : bot)),
  };
}
