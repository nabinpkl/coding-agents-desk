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
} from "@agentdesk/agent-feed-wire";
import { sessionTitleRefusal } from "../transcripts/sessionTitle.ts";
import { sessionKey } from "./botIdempotency.ts";
import { BotInvalidError } from "./botTypes.ts";

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
    (ref.source !== "claude" && ref.source !== "codex" && ref.source !== "pi")
    || typeof ref.sessionId !== "string"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(ref.sessionId)
  ) {
    throw new BotInvalidError("sessionRefs must name an existing source and sessionId");
  }
  return { source: ref.source, sessionId: ref.sessionId };
}

/**
 * The launch options, with the Bot's own name standing in for a title nobody gave.
 *
 * The title is validated by the same rule a rename obeys, because it is the same field: `-n`
 * writes it to the session registry, and a line break in it would split the argument rather than
 * the name. A Bot name is already bounded well inside that, so the default never refuses.
 */
function normalizeLaunch(value: unknown, botName: string): NormalizedLaunch | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BotInvalidError("launch must be an object");
  }
  const command = value as BotLaunchCommand;
  const title = compactOptional(command.title, "launch.title", MAX_NAME) ?? botName;
  const refusal = sessionTitleRefusal(title);
  if (refusal) throw new BotInvalidError(`launch.title: ${refusal}`);
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
    throw new BotInvalidError("directoryPath must be an absolute existing AgentDesk project path");
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
    launch: normalizeLaunch(command.launch, name),
  };
}

/**
 * A launch on an existing Bot, whose title cannot default to the Bot's name.
 *
 * At creation the Bot's name is the obvious title for its only session. On a Bot that already has
 * sessions it is the opposite: every session would be called the same thing, and `-n` makes that
 * name the address other agents send to. So a title is required here and defaulted there.
 */
export function normalizeLaunchFor(botId: string, value: unknown): NormalizedLaunch | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BotInvalidError("launch must be an object");
  }
  if (compactOptional((value as BotLaunchCommand).title, "launch.title", MAX_NAME) === undefined) {
    throw new BotInvalidError("launch.title is required when adding a session to an existing Bot");
  }
  return normalizeLaunch(value, botId);
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
