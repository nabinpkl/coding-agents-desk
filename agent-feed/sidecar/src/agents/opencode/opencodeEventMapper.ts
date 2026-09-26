// Translating one opencode session's serve envelopes into the feed's own rows.
//
// `session.messages` answers v1 envelopes: a user envelope carries text and
// files, an assistant envelope carries a `content` array of text, reasoning,
// and tool parts with their state inline. Both fold into the same blocks the
// transcript adapters emit, so a reader cannot tell a row came from an API
// rather than a file.
//
// Two measurements shape the rules. Reasoning arrives as a real lifecycle
// (start, deltas, end) but carries empty text when the provider encrypts its
// thinking, so an empty reasoning block is still emitted: present-but-empty,
// and the panel's collapse owns its display. A completed tool carries its
// input and its output in one part, so both blocks are emitted together under
// one call id and the panel pairs them the way it pairs a call with its
// response.

import type {
  LlmToolContent,
  SessionMessage,
} from "@opencode-ai/sdk/v2/client";
import { COMPOSER_IMAGE_MEDIA_TYPES } from "@agentdesk/agent-feed-wire";
import type {
  ActivityBlock,
  ParsedLine,
} from "@/transcripts/transcriptTypes";
import { LiveAgentProjection } from "@/agents/liveAgentProjection";
import { sanitizeAgentValue } from "@/agents/liveAgentProjection";
import { heuristicShellLabel } from "@/summary/shellLabels";

/**
 * Pictures this sidecar serves, keyed by what the feed addresses: image blocks carry only their
 * media type on the wire, so a page stays small whatever was pasted into it, and the bytes wait
 * here for the image route's on-demand read -- the same split Claude's transcript lines give,
 * except the store is this sync's memory rather than a file. Opencode's serve carries the bytes
 * inline (data URLs in tool parts, base64 in user files), so there is no second fetch to do.
 */
const SERVABLE_IMAGE_TYPES: ReadonlySet<string> = new Set(COMPOSER_IMAGE_MEDIA_TYPES);

export interface OpencodeImagePayload {
  /** The projection event id (`opencode:<message id>`), which the image route resolves. */
  eventId: string;
  /** Which picture of that event this is, in block order. */
  ordinal: number;
  mediaType: string;
  /** Base64 bytes, straight off the serve. */
  data: string;
}

/**
 * Output text past this is capped with a footer, the way the transcript
 * adapters cap tool previews: one pasted screenshot's worth of tool output
 * must not ride every page and every reconnect.
 */
const TOOL_OUTPUT_CAP = 8000;

export interface OpencodeSyncResult {
  /** True when the last envelope closes the turn rather than continuing it. */
  lastTurnClosed: boolean;
  /** True when any envelope is still open (no completion, tool running). */
  open: boolean;
  /** The pictures this batch carried, in block order per event, for the image route's store. */
  images: OpencodeImagePayload[];
}

export class OpencodeEventMapper {
  constructor(private readonly projection: LiveAgentProjection) {}

  /**
   * Replaces the projection's rows with what the serve just answered.
   *
   * The serve lists newest-first; the projection stores oldest-first, the
   * same chronological order every other source keeps (and opencode's own
   * timeline keeps a chronological array it appends live rows to). Insertion
   * order IS display order here, so syncing newest-first would read each
   * turn backwards, prompt after its reply. Updates stay where they are:
   * upsert keeps a known id's position and only new ids append.
   */
  sync(messages: SessionMessage[]): OpencodeSyncResult {
    const ordered = [...messages].sort((a, b) => messageTime(a) - messageTime(b));
    const images: OpencodeImagePayload[] = [];
    for (const message of ordered) {
      const parsed = this.translate(message, images);
      if (!parsed) continue;
      this.projection.upsert({
        ...parsed,
        id: `opencode:${message.id}`,
        phase: parsed.phase,
      });
    }
    const last = ordered.at(-1);
    // A trailing running compaction keeps the turn open without drawing a row: the notice beside
    // the thread IS its running state, and the banner is what landing earns. Without this a
    // refresh mid-compaction would report the session idle while the summariser streams.
    const lastCompacting = isCompactionRunning(last);
    return {
      lastTurnClosed: last === undefined || (!lastCompacting && turnClosed(last)),
      open: last !== undefined && (!turnClosed(last) || lastCompacting),
      images,
    };
  }

  private translate(
    message: SessionMessage,
    images: OpencodeImagePayload[],
  ): (ParsedLine & { phase: "streaming" | "complete" }) | null {
    switch (message.type) {
      case "user": {
        const blocks: ActivityBlock[] = [];
        if (message.text) blocks.push({ kind: "text", text: message.text });
        // Attached pictures become image blocks the way a tool's returned pictures do, so the
        // row draws them rather than naming them; anything else keeps its placeholder line.
        // The bytes ride the message itself, so they join the image route's store beside the row.
        const eventId = `opencode:${message.id}`;
        let ordinal = 0;
        for (const file of message.files ?? []) {
          const picture = attachedImage(file);
          if (picture) {
            blocks.push({ kind: "image", mediaType: picture.mediaType });
            images.push({ eventId, ordinal: ordinal++, mediaType: picture.mediaType, data: picture.data });
          } else {
            blocks.push({
              kind: "text",
              label: file.name ?? file.mime,
              text: `[Attached ${file.mime}]`,
            } as ActivityBlock);
          }
        }
        return { ts: message.time.created, type: "user", humanTurn: true, phase: "complete", blocks };
      }
      case "synthetic":
        return {
          ts: message.time.created,
          type: "user",
          phase: "complete",
          blocks: message.text ? [{ kind: "text", text: message.text }] : [],
        };
      case "system":
        return {
          ts: message.time.created,
          type: "system",
          phase: "complete",
          blocks: message.text ? [{ kind: "text", text: message.text }] : [],
        };
      case "shell": {
        const finished = message.time.completed !== undefined;
        // A raw command is a whole heredoc where a title should be; the
        // heuristic names the action instead. Claude rows are untouched --
        // their adapter already carries the harness's own description.
        const command = typeof message.command === "string" ? message.command : "";
        return {
          ts: message.time.created,
          type: "assistant",
          phase: finished ? "complete" : "streaming",
          blocks: [
            {
              kind: "tool_use",
              tool: "shell",
              callId: message.callID,
              input: { command: message.command } as Record<string, unknown>,
              summary: command.trim() ? heuristicShellLabel(command) : message.command,
            },
            ...(finished
              ? [{ kind: "tool_result", callId: message.callID, ...capText(message.output) } as ActivityBlock]
              : []),
          ],
        };
      }
      case "assistant": {
        const blocks: ActivityBlock[] = [];
        let open = message.time.completed === undefined;
        const eventId = `opencode:${message.id}`;
        let imageOrdinal = 0;
        for (const part of message.content) {
          if (part.type === "text") {
            if (part.text) blocks.push({ kind: "text", text: part.text });
          } else if (part.type === "reasoning") {
            // Always emitted, even empty: encrypted thinking still occupies
            // the row, and dropping it would read as "no thinking happened".
            blocks.push({ kind: "reasoning", text: part.text });
          } else if (part.type === "tool") {
            blocks.push({
              kind: "tool_use",
              tool: part.name,
              callId: part.id,
              input: (sanitizeAgentValue(toolInput(part.state)) ?? {}) as Record<string, unknown>,
              summary: toolTitle(part.name, part.state),
              files: toolFiles(part.state),
            });
            if (part.state.status === "completed") {
              blocks.push({ kind: "tool_result", callId: part.id, ...capText(toolOutput(part.state)) });
            } else if (part.state.status === "error") {
              blocks.push({ kind: "tool_result", callId: part.id, ...capText(toolError(part.state)) });
            } else {
              open = true;
            }
            // A picture a call returned is drawn, not named: an image block right after its
            // result, carrying the call's id the way Claude's adapter names each image by the
            // call whose result held it, so the panel pairs them. The text above already skips
            // imaged parts, so nothing reads twice. Only settled calls: a running call's
            // pictures have not arrived yet, and the row re-syncs when they do.
            if (part.state.status === "completed" || part.state.status === "error") {
              for (const picture of toolImages(part.state)) {
                blocks.push({ kind: "image", mediaType: picture.mediaType, callId: part.id });
                images.push({ eventId, ordinal: imageOrdinal++, mediaType: picture.mediaType, data: picture.data });
              }
            }
          }
        }
        return { ts: message.time.created, type: "assistant", phase: open ? "streaming" : "complete", blocks };
      }
      case "compaction": {
        // The TUI's own states, in feed terms. `running` draws nothing: the serve inserts the
        // checkpoint when compaction STARTS and flips it to `completed` when it lands, so a
        // banner for `running` reads "context compacted" minutes before anything compacted --
        // while the summary streams beside the thread through the compaction watch instead.
        // A cancelled compaction (`aborted`) draws nothing either, the way the TUI's mini
        // surface ends it silently; a genuine failure draws a text row naming the error rather
        // than a banner claiming the context compacted. Only `completed` (and the status-less
        // v1 shape, which is a landed row by construction) earns the banner.
        const status = (message as { status?: unknown }).status;
        if (status === "running") return null;
        if (status === "failed") {
          const error = (message as { error?: { type?: unknown; message?: unknown } }).error;
          if (error?.type === "aborted") return null;
          const detail = typeof error?.message === "string" && error.message ? error.message : "Compaction failed";
          return {
            ts: message.time.created,
            type: "system",
            phase: "complete",
            blocks: [{ kind: "text", text: `Compaction failed: ${detail}` }],
          };
        }
        const summary = (message as { summary?: unknown }).summary;
        return {
          ts: message.time.created,
          type: "system",
          phase: "complete",
          blocks: [{
            kind: "compaction",
            summary: message.reason,
            ...capText(typeof summary === "string" ? summary : ""),
          }],
        };
      }
      case "agent-switched":
        return {
          ts: message.time.created,
          type: "system",
          phase: "complete",
          blocks: [{ kind: "metadata", label: "Agent", text: message.agent }],
        };
      case "model-switched":
        return {
          ts: message.time.created,
          type: "system",
          phase: "complete",
          blocks: [{
            kind: "metadata",
            label: "Model",
            text: `${message.model.providerID}/${message.model.id}`,
          }],
        };
      default:
        // The serve also emits markers the SDK union does not name (`idle`):
        // content-free, nothing to draw, skipped rather than rendered.
        return null;
    }
  }
}

function messageTime(message: SessionMessage): number {
  return message.time.created;
}

/**
 * True while the summariser still owns the session: the checkpoint the serve inserted at
 * compaction start, not yet flipped to `completed` on landing. The feed draws no row for it
 * (the notice beside the thread is its running state), but the turn stays open so a refresh
 * mid-compaction does not report the session idle.
 */
function isCompactionRunning(message: SessionMessage | undefined): boolean {
  return message?.type === "compaction" &&
    (message as { status?: unknown }).status === "running";
}

function turnClosed(message: SessionMessage): boolean {
  if (message.type === "user" || message.type === "synthetic") return true;
  if (message.type === "assistant" || message.type === "shell") {
    return message.time.completed !== undefined;
  }
  return true;
}

function toolInput(state: { status: string; input?: unknown }): unknown {
  return "input" in state ? (state as { input: unknown }).input : {};
}

function toolFiles(state: { status: string }): string[] | undefined {
  if (state.status !== "completed") return undefined;
  const attachments = "attachments" in state
    ? (state as { attachments?: Array<{ uri?: string; name?: string }> }).attachments
    : undefined;
  if (!Array.isArray(attachments)) return undefined;
  const names = attachments
    .map((attachment) => attachment?.uri ?? attachment?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  return names.length > 0 ? names : undefined;
}

// A tool call's summary names what it acted on, never just the tool: the chip already says
// which tool ran, so `read read` spends the header repeating it instead of showing the file.
// Same convention as Claude's `summarizeToolUse` -- shell calls carry the raw command, file
// tools the basename, pattern tools the pattern -- so both sources read the same in one feed.
function toolTitle(name: string, state: { status: string; input?: unknown }): string | undefined {
  const input = "input" in state ? (state as { input?: unknown }).input : undefined;
  const fromInput = summarizeToolInput(
    name,
    input !== null && typeof input === "object" ? (input as Record<string, unknown>) : undefined,
  );
  if (fromInput) return fromInput;
  if ((state.status === "running" || state.status === "completed") && "title" in state) {
    const title = (state as { title?: unknown }).title;
    if (typeof title === "string" && title.length > 0) return `${name} · ${title}`;
  }
  // A file tool with nothing to name leaves the summary off: `edit edit`
  // spends the row repeating the tool instead of saying anything. Other
  // tools keep the name fallback pinned by the shell test below.
  if (name === "edit" || name === "Edit" || name === "write" || name === "Write" || name === "read" || name === "Read") {
    return undefined;
  }
  return name;
}

function toolString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function summarizeToolInput(name: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  switch (name) {
    case "shell":
    case "bash":
    case "Bash":
    case "exec_command": {
      const command = toolString(input["command"]) ?? toolString(input["cmd"]);
      return command ? heuristicShellLabel(command) : null;
    }
    case "read":
    case "edit":
    case "write": {
      const path = toolString(input["path"]) ?? toolString(input["file_path"]);
      return path ? `${name} ${path.split("/").pop() ?? path}` : null;
    }
    case "glob":
      return toolString(input["pattern"]);
    case "grep": {
      const pattern = toolString(input["pattern"]);
      return pattern ? `pattern "${pattern}"` : null;
    }
    case "question": {
      const questions = input["questions"];
      const first = Array.isArray(questions) ? questions[0] : undefined;
      const asked = first !== null && typeof first === "object"
        ? toolString((first as Record<string, unknown>)["header"]) ??
          toolString((first as Record<string, unknown>)["question"])
        : null;
      return asked ? `${name} ${asked.slice(0, 200)}` : null;
    }
    default: break;
  }
  // Distinctive keys before anything else, then any non-empty string of its own. `content`
  // and diff bodies never win here: their tools match a case above, so this only serves
  // tools with no rule of their own.
  for (const key of ["url", "query", "pattern", "path", "file_path", "command", "cmd"]) {
    const value = toolString(input[key]);
    if (value) return `${name} ${value.slice(0, 200)}`;
  }
  for (const value of Object.values(input)) {
    const text = toolString(value);
    if (text) return `${name} ${text.slice(0, 200)}`;
  }
  return null;
}

function toolOutput(state: { status: string }): string {
  if (state.status !== "completed" || !("content" in state)) return "";
  return toolContentText((state as { content?: LlmToolContent[] }).content);
}

function toolError(state: { status: string }): string {
  if (state.status !== "error") return "tool failed";
  if ("content" in state) {
    const text = toolContentText((state as { content?: LlmToolContent[] }).content);
    if (text) return text;
  }
  if ("error" in state) return errorText((state as { error?: unknown }).error);
  return "tool failed";
}

function toolContentText(content: LlmToolContent[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (item.type === "text") return item.text;
      // A picture is drawn, not named: its image block sits right after this result, so a line
      // reading `[image/png: ...]` above the picture would only repeat it. Anything else keeps
      // its placeholder, which is all the row can say about bytes it will not draw.
      if (toolFileImage(item)) return "";
      return `[${item.mime}${item.name ? `: ${item.name}` : ""}]`;
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * The pictures a settled tool call returned, as media type plus base64 bytes.
 *
 * Only inline data URLs in a servable image type. A `file://` URI names bytes on the serve's
 * machine that this sync cannot read -- and must not, from a model-written string -- so those
 * stay placeholder text. Checked here, where the part is made, because the media type later
 * becomes the image route's content-type on the panel's origin.
 */
function toolImages(state: { status: string }): Array<{ mediaType: string; data: string }> {
  if ((state.status !== "completed" && state.status !== "error") || !("content" in state)) return [];
  const content = (state as { content?: LlmToolContent[] }).content;
  if (!Array.isArray(content)) return [];
  const pictures: Array<{ mediaType: string; data: string }> = [];
  for (const item of content) {
    const picture = toolFileImage(item);
    if (picture) pictures.push(picture);
  }
  return pictures;
}

function toolFileImage(item: LlmToolContent): { mediaType: string; data: string } | null {
  if (item.type !== "file" || !SERVABLE_IMAGE_TYPES.has(item.mime)) return null;
  const prefix = `data:${item.mime};base64,`;
  if (typeof item.uri !== "string" || !item.uri.startsWith(prefix)) return null;
  const data = item.uri.slice(prefix.length);
  return data.length > 0 ? { mediaType: item.mime, data } : null;
}

/**
 * A picture attached to a user message, which carries raw base64 rather than a data URL.
 * Same servable-types gate as tool pictures, for the same content-type reason.
 */
function attachedImage(file: { mime?: unknown; data?: unknown }): { mediaType: string; data: string } | null {
  if (typeof file.mime !== "string" || !SERVABLE_IMAGE_TYPES.has(file.mime)) return null;
  if (typeof file.data !== "string" || file.data.length === 0) return null;
  return { mediaType: file.mime, data: file.data };
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "tool failed";
}

/** Caps long output with the same footer shape the transcript adapters use. */
function capText(text: string): { text: string; preview: string; hiddenChars?: number; hiddenLines?: number } {
  // `preview` is always set, not just past the cap: the panel renders a
  // tool result from `preview`, so a result with only `text` reads as
  // "(empty result)" no matter how much output it holds. Measured in the
  // panel against a shell call that returned two lines.
  if (text.length <= TOOL_OUTPUT_CAP) return { text, preview: text };
  const kept = text.slice(0, TOOL_OUTPUT_CAP);
  const hidden = text.slice(TOOL_OUTPUT_CAP);
  return {
    text: kept,
    preview: kept,
    hiddenChars: hidden.length,
    hiddenLines: hidden.split("\n").length - 1,
  };
}
