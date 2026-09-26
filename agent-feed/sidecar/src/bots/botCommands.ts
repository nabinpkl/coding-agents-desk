// Turning a request off the wire into something the registry can act on: every length
// limit, every field's normal form, and the refusals a malformed command earns.
//
// All of it happens before anything is written, which is what lets the registry's own
// methods assume a command is already sane.

import type {
  AddBotCommand,
  BotGrant,
  BotLaunchCommand,
  BotMetadata,
  BotSessionRef,
  RetireBotSessionsCommand,
} from "@agentdesk/agent-feed-wire";
import { disposalRefusal } from "@/git/sessionRetirement";
import { sessionTitleRefusal } from "@/transcripts/session-ops/sessionTitle";
import { sessionKey } from "@/bots/botIdempotency";
import { BotInvalidError } from "@/bots/botTypes";

const MAX_NAME = 64;
const MAX_DIRECTORY_PATH = 4_096;
const MAX_ROLE = 120;
const MAX_DESCRIPTION = 1_000;
const MAX_LABELS = 12;
const MAX_LABEL = 32;
const MAX_CUSTOM_ENTRIES = 16;
const MAX_CUSTOM_KEY = 64;
const MAX_CUSTOM_VALUE = 256;
const MAX_ICON_URL = 2_048;
/**
 * How long a launch prompt may be.
 *
 * It becomes one argv element passed through two shells, where the ceiling is the kernel's
 * argument limit, about a megabyte -- so this is not that constraint. It is the size at which a
 * "first turn" has stopped being one: a grounding brief written by hand runs a few thousand
 * characters, and something ten times that belongs in a file the session reads for itself.
 */
const MAX_LAUNCH_PROMPT = 32_768;
const MAX_SESSION_REFS_PER_COMMAND = 64;

export interface NormalizedAddBot {
  requestId: string;
  name: string;
  normalizedName: string;
  iconUrl?: string;
  directoryPath: string;
  metadata: BotMetadata;
  grants: BotGrant[];
  launch?: NormalizedLaunch;
}

export interface NormalizedLaunch {
  title: string;
  prompt?: string;
  from?: BotSessionRef;
  worktree?: { branch?: string };
}

export interface NormalizedSessionRefCommand {
  requestId: string;
  sessionRefs: BotSessionRef[];
}

function compactOptional(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new BotInvalidError(`${name} must be a string`);
  const compact = value.trim();
  if (compact === "") return undefined;
  if (compact.length > maximum) throw new BotInvalidError(`${name} must be at most ${maximum} characters`);
  return compact;
}

function normalizeRequestId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new BotInvalidError("requestId is required and must be a bounded identifier");
  }
  return value;
}

function normalizeName(value: unknown): { name: string; normalizedName: string } {
  const name = compactOptional(value, "name", MAX_NAME);
  if (!name) throw new BotInvalidError("name is required");
  return { name, normalizedName: name.normalize("NFKC").toLocaleLowerCase("en-US") };
}

function normalizeIconUrl(value: unknown): string | undefined {
  const raw = compactOptional(value, "iconUrl", MAX_ICON_URL);
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new BotInvalidError("iconUrl must be a valid https URL", { cause: error });
  }
  if (url.protocol !== "https:") throw new BotInvalidError("iconUrl must use https");
  return url.toString();
}

function normalizeLabels(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LABELS) {
    throw new BotInvalidError(`metadata.labels must contain at most ${MAX_LABELS} strings`);
  }
  const labels = value.map((entry) => compactOptional(entry, "metadata label", MAX_LABEL));
  if (labels.some((entry) => entry === undefined)) {
    throw new BotInvalidError("metadata labels cannot be empty");
  }
  return [...new Set(labels as string[])];
}

function normalizeCustom(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BotInvalidError("metadata.custom must be an object of string values");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_CUSTOM_ENTRIES) {
    throw new BotInvalidError(`metadata.custom must contain at most ${MAX_CUSTOM_ENTRIES} entries`);
  }
  const normalized: Record<string, string> = {};
  for (const [key, raw] of entries) {
    const normalizedKey = compactOptional(key, "metadata key", MAX_CUSTOM_KEY);
    const normalizedValue = compactOptional(raw, `metadata.${key}`, MAX_CUSTOM_VALUE);
    if (!normalizedKey || !normalizedValue) {
      throw new BotInvalidError("metadata custom keys and values cannot be empty");
    }
    normalized[normalizedKey] = normalizedValue;
  }
  return normalized;
}

function normalizeGrants(value: unknown): BotGrant[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((grant) => grant !== "add_bot")) {
    throw new BotInvalidError('grants may contain only "add_bot"');
  }
  return value.includes("add_bot") ? ["add_bot"] : [];
}

export function normalizeSessionRef(value: unknown): BotSessionRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BotInvalidError("sessionRefs must contain source-qualified session references");
  }
  const ref = value as Partial<BotSessionRef>;
  if (
    (ref.source !== "claude" && ref.source !== "codex" && ref.source !== "pi" && ref.source !== "opencode")
    || typeof ref.sessionId !== "string"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(ref.sessionId)
  ) {
    throw new BotInvalidError("sessionRefs must name an existing source and sessionId");
  }
  return { source: ref.source, sessionId: ref.sessionId };
}

export interface NormalizedBracket {
  ref: BotSessionRef;
  /** The bracket task, trimmed. Empty starts the session bare under its anchor. */
  task: string;
}

/**
 * A bracket rename: which session, and what it is doing now.
 *
 * The task is bounded like a launch title for the same reason -- it becomes one argument to the
 * session's own rename -- and refused for line breaks up front. Parentheses and the composed
 * length are the registry's call, beside the anchor they compose with.
 */
export function normalizeBracketCommand(value: unknown): NormalizedBracket {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BotInvalidError("request body must be an object");
  }
  const command = value as { source?: unknown; sessionId?: unknown; task?: unknown };
  const ref = normalizeSessionRef({ source: command.source, sessionId: command.sessionId });
  if (typeof command.task !== "string") throw new BotInvalidError("task must be a string");
  const task = command.task.trim();
  if (task.length > MAX_NAME) throw new BotInvalidError(`task must be at most ${MAX_NAME} characters`);
  if (/[\n\r]/.test(task)) throw new BotInvalidError("task cannot contain a line break");
  return { ref, task };
}

/**
 * The launch options: what the session is working on, as task text.
 *
 * The title is validated by the same rule a rename obeys, because it is the same field: `-n`
 * writes the composed title to the session registry, and a line break in it would split the
 * argument rather than the name. Omitted starts bare under the allocated anchor. The anchor
 * itself is spent at launch time and never arrives over this wire.
 */
function normalizeLaunch(value: unknown): NormalizedLaunch | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BotInvalidError("launch must be an object");
  }
  const command = value as BotLaunchCommand;
  const requested = compactOptional(command.title, "launch.title", MAX_NAME);
  if (requested !== undefined) {
    const refusal = sessionTitleRefusal(requested);
    if (refusal) throw new BotInvalidError(`launch.title: ${refusal}`);
  }
  const title = requested ?? "";
  if (command.from !== undefined && normalizeSessionRef(command.from).source !== "claude") {
    // `--fork-session` is a Claude CLI flag. Codex has `resume` and no fork, so a Codex source
    // would be silently resumed into the original transcript rather than branched from it.
    throw new BotInvalidError("launch.from must name a claude session");
  }
  return {
    title,
    // Only trimmed, never reshaped: the prompt is the session's first turn and its line breaks
    // are the reader's.
    prompt: compactOptional(command.prompt, "launch.prompt", MAX_LAUNCH_PROMPT),
    ...(command.from === undefined ? {} : { from: normalizeSessionRef(command.from) }),
    ...(command.worktree === undefined ? {} : { worktree: normalizeWorktree(command.worktree) }),
  };
}

/**
 * The worktree request, if there is one.
 *
 * The branch is optional and the sidecar derives it from the title, so `{}` is the ordinary thing
 * to send: a reader ticking a box has an opinion about isolation and none about branch names.
 */
function normalizeWorktree(value: unknown): { branch?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BotInvalidError("launch.worktree must be an object");
  }
  const branch = compactOptional((value as { branch?: unknown }).branch, "launch.worktree.branch", MAX_NAME);
  return branch === undefined ? {} : { branch };
}

export function normalizeAddBot(command: AddBotCommand): NormalizedAddBot {
  const { name, normalizedName } = normalizeName(command.name);
  const directoryPath = compactOptional(command.directoryPath, "directoryPath", MAX_DIRECTORY_PATH);
  if (!directoryPath?.startsWith("/")) {
    throw new BotInvalidError("directoryPath must be an absolute path to an existing directory");
  }
  return {
    requestId: normalizeRequestId(command.requestId),
    name,
    normalizedName,
    iconUrl: normalizeIconUrl(command.iconUrl),
    directoryPath,
    metadata: {
      role: compactOptional(command.metadata?.role, "metadata.role", MAX_ROLE),
      description: compactOptional(command.metadata?.description, "metadata.description", MAX_DESCRIPTION),
      labels: normalizeLabels(command.metadata?.labels),
      custom: normalizeCustom(command.metadata?.custom),
    },
    grants: normalizeGrants(command.grants),
    launch: normalizeLaunch(command.launch),
  };
}

/**
 * A launch on an existing Bot.
 *
 * The title is task text, never the anchor: the anchor is spent at launch time and this
 * normalizer cannot know it yet. Omitted starts bare.
 */
/**
 * A Bot edit: every field optional, at least one required.
 *
 * Clearing follows the creator dialog's shape rather than inventing its own: an empty string
 * where a value lives (icon, role, description) removes it, because a reader clearing a field
 * deletes its text rather than reaching for null. Labels and custom replace wholesale per
 * field -- merging two label lists element-wise would make removing one label unsayable.
 * `fatherSession: null` clears the Father; omitted leaves it. Grants are absent on purpose:
 * only creation hands out management powers.
 */
export interface NormalizedUpdateBot {
  name?: string;
  normalizedName?: string;
  iconUrl?: string | null;
  /** Only the metadata keys the caller named; each replaces wholesale, the rest stay. */
  metadata?: { role?: string; description?: string; labels?: string[]; custom?: Record<string, string> };
  fatherSession?: BotSessionRef | null;
}

export function normalizeUpdateBot(command: unknown): NormalizedUpdateBot {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new BotInvalidError("request body must be an object");
  }
  const { name, iconUrl, metadata, fatherSession } = command as {
    name?: unknown;
    iconUrl?: unknown;
    metadata?: unknown;
    fatherSession?: unknown;
  };
  if (name === undefined && iconUrl === undefined && metadata === undefined && fatherSession === undefined) {
    throw new BotInvalidError("name, iconUrl, metadata or fatherSession is required");
  }
  const normalized: NormalizedUpdateBot = {};
  if (name !== undefined) {
    const { name: trimmed, normalizedName } = normalizeName(name);
    normalized.name = trimmed;
    normalized.normalizedName = normalizedName;
  }
  if (iconUrl !== undefined) {
    if (typeof iconUrl !== "string") throw new BotInvalidError("iconUrl must be a string");
    // Empty clears to the initials; anything else obeys the creation rule.
    normalized.iconUrl = iconUrl.trim() === "" ? null : normalizeIconUrl(iconUrl);
  }
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new BotInvalidError("metadata must be an object");
    }
    // Only the keys the caller named: each one replaces wholesale, and the rest stay. An
    // explicit undefined value counts as unnamed -- JSON cannot carry it, so nothing can mean
    // it -- while an empty string clears role and description the way the creator dialog reads
    // a deleted field.
    const raw = metadata as Record<string, unknown>;
    const merged: { role?: string; description?: string; labels?: string[]; custom?: Record<string, string> } = {};
    if (raw.role !== undefined) merged.role = compactOptional(raw.role, "metadata.role", MAX_ROLE);
    if (raw.description !== undefined) {
      merged.description = compactOptional(raw.description, "metadata.description", MAX_DESCRIPTION);
    }
    if (raw.labels !== undefined) merged.labels = normalizeLabels(raw.labels);
    if (raw.custom !== undefined) merged.custom = normalizeCustom(raw.custom);
    normalized.metadata = merged;
  }
  if (fatherSession !== undefined) {
    // Null clears; a reference must parse, and membership is the registry's call beside the
    // record it checks against.
    normalized.fatherSession = fatherSession === null ? null : normalizeSessionRef(fatherSession);
  }
  return normalized;
}

export function normalizeLaunchFor(botId: string, value: unknown): NormalizedLaunch | undefined {
  void botId;
  return normalizeLaunch(value);
}

export function normalizeSessionRefCommand(
  command: { requestId: string; sessionRefs?: BotSessionRef[] },
  { optional = false }: { optional?: boolean } = {},
): NormalizedSessionRefCommand {
  if (optional && command.sessionRefs === undefined) {
    return { requestId: normalizeRequestId(command.requestId), sessionRefs: [] };
  }
  if (!Array.isArray(command.sessionRefs) || command.sessionRefs.length === 0) {
    throw new BotInvalidError("sessionRefs must contain at least one session");
  }
  if (command.sessionRefs.length > MAX_SESSION_REFS_PER_COMMAND) {
    throw new BotInvalidError(`sessionRefs may contain at most ${MAX_SESSION_REFS_PER_COMMAND} sessions`);
  }
  const sessionRefs = command.sessionRefs.map(normalizeSessionRef);
  if (new Set(sessionRefs.map(sessionKey)).size !== sessionRefs.length) {
    throw new BotInvalidError("sessionRefs cannot contain duplicates");
  }
  return { requestId: normalizeRequestId(command.requestId), sessionRefs };
}

export interface NormalizedRetire extends NormalizedSessionRefCommand {
  worktree: "remove" | "keep";
  branch: "delete" | "keep";
  remote: "delete" | "keep";
}

/**
 * The retire command, with every disposal defaulted to keep and the impossible pairs refused.
 *
 * Defaulting HERE rather than at the far end is what makes the idempotency signature honest: two
 * requests that differ only in spelling `worktree: "keep"` out loud versus leaving it off are the
 * same command, and a replay of one has to answer the other rather than running again.
 *
 * The two refusals are cross-field, so they cannot live on the individual readers below. Both are
 * refusals rather than silent reinterpretations because each one is a caller believing something
 * about what this call will do:
 *
 * - Deleting a branch a worktree still has checked out is something git will not do, so the pair
 *   that keeps the worktree could never have deleted the branch. Accepting it would report success
 *   for a step that never ran.
 * - Deleting the remote copy without deleting the local one skips the only merged-ness check in
 *   the whole sequence, since `git branch -d` is what stands in for "these commits are safe to
 *   lose". Dropping the guard on the copy that is hardest to get back is the wrong way round.
 */
export function normalizeRetire(command: RetireBotSessionsCommand): NormalizedRetire {
  const refs = normalizeSessionRefCommand(command);
  const worktree = disposal(command.worktree, ["remove", "keep"], "keep", "worktree");
  const branch = disposal(command.branch, ["delete", "keep"], "keep", "branch");
  const remote = disposal(command.remote, ["delete", "keep"], "keep", "remote");
  // The same question `planSessionRetirement` asks, read from the one place it is written. Asked
  // here as well so a malformed request is a 400 at the edge rather than a conflict from the core.
  const impossible = disposalRefusal({ worktree, branch, remote });
  if (impossible) throw new BotInvalidError(impossible);
  return { ...refs, worktree, branch, remote };
}

/** The default is named at each call rather than taken from the list's order, which would change
 *  meaning the day a third disposal is added to one of them. */
function disposal<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  name: string,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new BotInvalidError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}
