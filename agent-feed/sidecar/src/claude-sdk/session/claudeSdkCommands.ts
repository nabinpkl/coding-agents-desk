// The panel's commands to an SDK session, checked field by field before anything is asked of it.
//
// Its own file because a request body is untrusted until it has been read, and every rule for
// reading one -- how many images, which fields an answer carries, what a rename may contain -- is
// here, apart from the session that acts on the result.

import type { ClaudeEffortLevel, ClaudePermissionMode, TmuxQuestionAnswer, TmuxQuestionRefusal } from "@agentdesk/agent-feed-wire";
import { CLAUDE_EFFORT_LEVELS, CLAUDE_PERMISSION_MODES } from "@agentdesk/agent-feed-wire";
import { isId, isModelName, type PromptImageType } from "@/claude-sdk/claudeSdkProtocol";

/** One image riding a prompt, as the Messages API takes it. */
export interface PromptImage {
  mediaType: PromptImageType;
  /** Base64, no data-URL prefix. */
  data: string;
}

/** What the panel asks of an SDK session, before it is turned into what the runner takes. */
export type SessionCommand =
  | { type: "prompt"; text: string; images?: PromptImage[] }
  | { type: "answer"; answers: TmuxQuestionAnswer[] }
  | { type: "decide"; toolUseId: string; allow: boolean; message?: string }
  | { type: "set-mode"; mode: ClaudePermissionMode }
  | { type: "set-model"; model: string }
  | { type: "set-effort"; effort: ClaudeEffortLevel }
  | { type: "interrupt" }
  | { type: "rename"; title: string }
  | { type: "stop" };

/** Why a command did not happen. An answer's refusals are the terminal dialog's own words. */
export type SessionRefusal = "not-pending" | "invalid" | "failed" | TmuxQuestionRefusal;

export type SessionReply = { ok: true } | { ok: false; reason: SessionRefusal; message: string };

const isString = (value: unknown): value is string => typeof value === "string";
type Fields = Record<string, unknown>;

const isEffortLevel = (value: unknown): value is ClaudeEffortLevel => (CLAUDE_EFFORT_LEVELS as readonly unknown[]).includes(value);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** As many as the panel's own send takes (`parseMessageAttachments`). */
const MAXIMUM_PROMPT_IMAGES = 5;

function questionAnswers(value: unknown): TmuxQuestionAnswer[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return null;
  const answers: TmuxQuestionAnswer[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return null;
    const { question, chosen, other } = entry as Fields;
    if (!isString(question) || !isString(other) || !Array.isArray(chosen)) return null;
    const picks: TmuxQuestionAnswer["chosen"] = [];
    for (const pick of chosen) {
      if (pick === null || typeof pick !== "object") return null;
      const { index, label } = pick as Fields;
      if (!Number.isInteger(index) || (index as number) < 0 || !isString(label)) return null;
      picks.push({ index: index as number, label });
    }
    answers.push({ question, chosen: picks, other });
  }
  return answers;
}

function promptImages(value: unknown): PromptImage[] | null {
  if (!Array.isArray(value) || value.length > MAXIMUM_PROMPT_IMAGES) return null;
  const images: PromptImage[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return null;
    const { mediaType, data } = entry as Fields;
    if (!IMAGE_TYPES.has(mediaType as string) || !isString(data) || data.length === 0) return null;
    images.push({ mediaType: mediaType as PromptImageType, data });
  }
  return images;
}

/** A command a request describes, checked field by field, or null for one that is not a command. */
export function parseSessionCommand(fields: Fields): SessionCommand | null {
  switch (fields.type) {
    case "prompt": {
      if (!isString(fields.text) || fields.text.trim().length === 0) return null;
      if (fields.images === undefined) return { type: "prompt", text: fields.text };
      const images = promptImages(fields.images);
      return images ? { type: "prompt", text: fields.text, images } : null;
    }
    case "answer": {
      const answers = questionAnswers(fields.answers);
      return answers ? { type: "answer", answers } : null;
    }
    case "decide":
      if (!isId(fields.toolUseId) || typeof fields.allow !== "boolean") return null;
      if (fields.message !== undefined && !isString(fields.message)) return null;
      return {
        type: "decide",
        toolUseId: fields.toolUseId,
        allow: fields.allow,
        ...(isString(fields.message) ? { message: fields.message } : {}),
      };
    case "set-mode": {
      const mode = fields.mode;
      return (CLAUDE_PERMISSION_MODES as readonly unknown[]).includes(mode) ? { type: "set-mode", mode: mode as ClaudePermissionMode } : null;
    }
    case "set-model":
      return isModelName(fields.model) ? { type: "set-model", model: fields.model } : null;
    case "set-effort":
      return isEffortLevel(fields.effort) ? { type: "set-effort", effort: fields.effort } : null;
    case "interrupt":
      return { type: "interrupt" };
    case "rename":
      return isString(fields.title) && fields.title.trim().length > 0 && !/[\r\n]/.test(fields.title)
        ? { type: "rename", title: fields.title }
        : null;
    case "stop":
      return { type: "stop" };
    default:
      return null;
  }
}
