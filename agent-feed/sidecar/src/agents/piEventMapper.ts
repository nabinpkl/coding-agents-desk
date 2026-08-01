import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ActivityBlock, ParsedLine } from "../transcripts/sources/transcriptTypes.ts";
import { LiveAgentProjection, sanitizeAgentValue } from "./liveAgentProjection.ts";

type AgentMessage = Extract<AgentSessionEvent, { type: "message_start" }>['message'];

export class PiEventMapper {
  private noticeSequence = 0;
  private messageSequence = 0;
  private readonly messageIds = new WeakMap<object, string>();
  private readonly activeMessageIds = new Map<string, string>();

  constructor(private readonly projection: LiveAgentProjection) {}

  seed(messages: readonly AgentMessage[]): void {
    for (const message of messages) this.mapMessage(message, "complete");
  }

  accept(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.projection.setState("running");
        return;
      case "agent_settled":
        this.projection.setState("idle", { steer: 0, followUp: 0 });
        return;
      case "queue_update":
        this.projection.setState(this.projection.runState, {
          steer: event.steering.length,
          followUp: event.followUp.length,
        });
        return;
      case "message_start":
      case "message_update":
        this.mapMessage(event.message, "streaming");
        return;
      case "message_end":
        this.mapMessage(event.message, "complete");
        return;
      case "tool_execution_start":
        this.mapTool(event.toolCallId, event.toolName, event.args, undefined, false, "streaming");
        return;
      case "tool_execution_update":
        this.mapTool(event.toolCallId, event.toolName, event.args, event.partialResult, false, "streaming");
        return;
      case "tool_execution_end":
        this.mapTool(event.toolCallId, event.toolName, undefined, event.result, event.isError, "complete");
        return;
      case "compaction_start":
        this.notice("Compaction", `Started (${event.reason})`, "compaction");
        return;
      case "compaction_end":
        this.notice(
          "Compaction",
          event.aborted ? "Aborted" : event.errorMessage ?? "Completed",
          "compaction",
        );
        return;
      case "auto_retry_start":
        this.notice("Retry", `Attempt ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
        return;
      case "auto_retry_end":
        this.notice("Retry", event.success ? "Recovered" : event.finalError ?? "Failed");
        return;
      case "session_info_changed":
        this.notice("Session", event.name ?? "Unnamed");
        return;
      case "agent_end":
      case "entry_appended":
      case "thinking_level_changed":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
      case "bash_execution_update":
      case "turn_start":
      case "turn_end":
        return;
    }
  }

  private mapMessage(message: AgentMessage, phase: "streaming" | "complete"): void {
    const id = this.messageId(message, phase);
    if (message.role === "toolResult") {
      this.mapTool(message.toolCallId, message.toolName, undefined, message, message.isError, phase);
      return;
    }
    const standard = message.role === "user" || message.role === "assistant";
    const type = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "system";
    let blocks = message.role === "user"
      ? userBlocks(message.content)
      : message.role === "assistant"
      ? assistantBlocks(message.content)
      : [{ kind: "metadata" as const, label: message.role, text: textFromUnknown(message) }];
    if (message.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
      blocks = [
        ...blocks.filter((block) => block.kind !== "text" || Boolean(block.text?.trim())),
        { kind: "metadata", label: "Error", text: message.errorMessage },
      ];
    }
    this.projection.upsert({
      id,
      ts: message.timestamp,
      type: standard ? type : "system",
      phase: standard ? phase : "complete",
      blocks,
    });
  }

  private messageId(message: AgentMessage, phase: "streaming" | "complete"): string {
    const object = message as object;
    const known = this.messageIds.get(object);
    if (known) {
      if (phase === "complete") this.activeMessageIds.delete(`${message.role}:${message.timestamp}`);
      return known;
    }
    const key = `${message.role}:${message.timestamp}`;
    const active = this.activeMessageIds.get(key);
    if (active) {
      this.messageIds.set(object, active);
      if (phase === "complete") this.activeMessageIds.delete(key);
      return active;
    }
    const id = `message:${this.messageSequence++}:${key}`;
    this.messageIds.set(object, id);
    if (phase === "streaming") this.activeMessageIds.set(key, id);
    return id;
  }

  private mapTool(
    callId: string,
    tool: string,
    args: unknown,
    result: unknown,
    isError: boolean,
    phase: "streaming" | "complete",
  ): void {
    const preview = textFromUnknown(result) || (phase === "streaming" ? "Running…" : "Completed");
    const input = sanitizeRecord(args);
    this.projection.upsert({
      id: `tool:${callId}`,
      ts: Date.now(),
      type: "system",
      phase,
      blocks: [{
        kind: "tool_result",
        tool,
        label: isError ? `${tool} failed` : tool,
        callId,
        preview,
        ...(input ? { input } : {}),
      }],
    });
  }

  private notice(label: string, text: string, kind: ActivityBlock["kind"] = "metadata"): void {
    const sequence = ++this.noticeSequence;
    this.projection.upsert({
      id: `notice:${sequence}`,
      ts: Date.now(),
      type: "system",
      phase: "complete",
      blocks: [{ kind, label, text }],
    });
  }
}

function userBlocks(content: unknown): ActivityBlock[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [{ kind: "metadata", text: textFromUnknown(content) }];
  return content.flatMap((item): ActivityBlock[] => {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      return [{ kind: "text", text: item.text }];
    }
    return [{ kind: "metadata", label: "Attachment", text: textFromUnknown(item) }];
  });
}

function assistantBlocks(content: unknown): ActivityBlock[] {
  if (!Array.isArray(content)) return [{ kind: "metadata", text: textFromUnknown(content) }];
  return content.flatMap((item): ActivityBlock[] => {
    if (!isRecord(item)) return [];
    if (item.type === "text" && typeof item.text === "string") {
      return [{ kind: "text", text: item.text }];
    }
    if (item.type === "thinking" && typeof item.thinking === "string") {
      return [{ kind: "reasoning", text: item.thinking }];
    }
    if (
      item.type === "toolCall" &&
      typeof item.id === "string" &&
      typeof item.name === "string"
    ) {
      return [{
        kind: "tool_use",
        tool: item.name,
        callId: item.id,
        input: sanitizeRecord(item.arguments),
      }];
    }
    return [{ kind: "metadata", text: textFromUnknown(item) }];
  });
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && Array.isArray(value.content)) {
    const text = value.content.flatMap((item) =>
      isRecord(item) && item.type === "text" && typeof item.text === "string"
        ? [item.text]
        : []
    ).join("\n");
    if (text) return text;
  }
  return JSON.stringify(sanitizeAgentValue(value));
}

function sanitizeRecord(value: unknown): Record<string, unknown> | undefined {
  const sanitized = sanitizeAgentValue(value);
  return isRecord(sanitized) && !Array.isArray(sanitized) ? sanitized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
