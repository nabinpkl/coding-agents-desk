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
import type {
  ActivityBlock,
  ParsedLine,
} from "@/transcripts/transcriptTypes";
import { LiveAgentProjection } from "@/agents/liveAgentProjection";
import { sanitizeAgentValue } from "@/agents/liveAgentProjection";

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
}

export class OpencodeEventMapper {
  constructor(private readonly projection: LiveAgentProjection) {}

  /**
   * Replaces the projection's rows with what the serve just answered.
   *
   * Whole-list rather than incremental: the serve is the durable record and a
   * refresh is one round trip, so there is no stream id to track and no delta
   * to lose. The projection dedupes unchanged rows by content, so a refresh
   * that changed nothing publishes nothing.
   */
  sync(messages: SessionMessage[]): OpencodeSyncResult {
    for (const message of messages) {
      const parsed = this.translate(message);
      if (!parsed) continue;
      this.projection.upsert({
        ...parsed,
        id: `opencode:${message.id}`,
        phase: parsed.phase,
      });
    }
    const last = messages.at(-1);
    return {
      lastTurnClosed: last === undefined || turnClosed(last),
      open: last !== undefined && !turnClosed(last),
    };
  }

  private translate(message: SessionMessage): (ParsedLine & { phase: "streaming" | "complete" }) | null {
    switch (message.type) {
      case "user":
        return {
          ts: message.time.created,
          type: "user",
          humanTurn: true,
          phase: "complete",
          blocks: [
            ...(message.text ? [{ kind: "text", text: message.text } as ActivityBlock] : []),
            ...(message.files ?? []).map((file) => ({
              kind: "text",
              label: file.name ?? file.mime,
              text: `[Attached ${file.mime}]`,
            }) as ActivityBlock),
          ],
        };
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
              summary: message.command,
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
          }
        }
        return { ts: message.time.created, type: "assistant", phase: open ? "streaming" : "complete", blocks };
      }
      case "compaction":
        return {
          ts: message.time.created,
          type: "system",
          phase: "complete",
          blocks: [{ kind: "compaction", summary: message.reason, ...capText(message.summary) }],
        };
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
    }
  }
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

function toolTitle(name: string, state: { status: string }): string {
  if ((state.status === "running" || state.status === "completed") && "title" in state) {
    const title = (state as { title?: unknown }).title;
    if (typeof title === "string" && title.length > 0) return `${name} · ${title}`;
  }
  return name;
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
      return `[${item.mime}${item.name ? `: ${item.name}` : ""}]`;
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "tool failed";
}

/** Caps long output with the same footer shape the transcript adapters use. */
function capText(text: string): { text: string; preview?: string; hiddenChars?: number; hiddenLines?: number } {
  if (text.length <= TOOL_OUTPUT_CAP) return { text };
  const kept = text.slice(0, TOOL_OUTPUT_CAP);
  const hidden = text.slice(TOOL_OUTPUT_CAP);
  return {
    text: kept,
    preview: kept,
    hiddenChars: hidden.length,
    hiddenLines: hidden.split("\n").length - 1,
  };
}
