// One rollout line as the blocks a reader sees.
//
// Every nonempty JSONL line becomes exactly one normalized record: its class, its
// label, its blocks, and whatever it says about the turn. `processLine` and
// `extractBlockRaw` both read this, which is what keeps a block's index the same in
// the feed and in the Raw drawer.

import type { LineResult, ParsedLine } from "@/transcripts/transcriptTypes";
import { isHumanTurnStart } from "@/transcripts/humanTurns";
import {
  metadataBlock,
  metadataText,
  plainBlock,
  plainEvent,
  rawBlock,
  stringifyForDisplay,
} from "@/transcripts/plainActivity";
import {
  CODEX_EVENT_LABELS,
  CODEX_TOP_LEVEL_LABELS,
  makeToolResultBlock,
  outputToString,
  parseArgs,
  patchAppliedBlock,
  summarizeToolUse,
  tsMs,
  turnClosedFor,
  type EventMsgPayload,
  type NormalizedCodexBlock,
  type NormalizedCodexLine,
  type ResponseItemPayload,
} from "@/transcripts/codex/codexPayloads";
import { extractReasoningText } from "@/transcripts/codex/codexReasoning";
import { classifyCodexLine } from "@/transcripts/lineClass";

export function normalizeMessageContent(content: unknown): NormalizedCodexBlock[] {
  if (typeof content === 'string') {
    return content.trim()
      ? [{ block: { kind: 'text', text: content }, raw: content }]
      : [{ block: plainBlock(content), raw: content }];
  }
  if (!Array.isArray(content)) {
    return [{ block: plainBlock(content), raw: stringifyForDisplay(content) }];
  }
  const blocks: NormalizedCodexBlock[] = [];
  for (const item of content) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      if ((record.type === 'input_text' || record.type === 'output_text') && typeof record.text === 'string' && record.text.trim()) {
        blocks.push({ block: { kind: 'text', text: record.text }, raw: record.text });
        continue;
      }
    }
    blocks.push({ block: plainBlock(item), raw: stringifyForDisplay(item) });
  }
  return blocks.length > 0 ? blocks : [{ block: plainBlock(content), raw: stringifyForDisplay(content) }];
}

export function normalizedLine(line: string): NormalizedCodexLine | null {
  if (!line.trim()) return null;
  let ev: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const blocks = [{ block: plainBlock(line), raw: line }, { block: rawBlock(), raw: line }];
      return { result: { event: plainEvent(line) }, rawBlocks: blocks };
    }
    ev = parsed as typeof ev;
  } catch {
    const blocks = [{ block: plainBlock(line), raw: line }, { block: rawBlock(), raw: line }];
    return { result: { event: plainEvent(line) }, rawBlocks: blocks };
  }
  const normalized = normalizedRecord(line, ev);
  // Stamped here, once, from the parsed record rather than the rendered blocks:
  // `normalizedRecord` returns from a dozen branches, and a new branch that forgot
  // this would silently leak a machinery row into the nice view. An unparseable
  // line above keeps the default, which is content -- we cannot tell what it is,
  // so it stays visible.
  normalized.result.lineClass = classifyCodexLine(ev);
  return normalized;
}

export function normalizedRecord(
  line: string,
  ev: { timestamp?: string; type?: string; payload?: Record<string, unknown> },
): NormalizedCodexLine {
  const ts = tsMs(ev);
  const top = ev.type;
  const p = ev.payload;

  const finish = (
    type: ParsedLine['type'],
    blocks: NormalizedCodexBlock[],
    stateUpdates: Omit<LineResult, 'event'> = {},
    messageId?: string,
  ): NormalizedCodexLine => {
    const rawBlocks = [...blocks, { block: rawBlock(), raw: line }];
    const event: ParsedLine = {
      ts,
      type,
      blocks: rawBlocks.map(({ block }) => block),
      ...(messageId ? { messageId } : {}),
    };
    // Codex has its own envelopes -- the injected `AGENTS.md instructions` ahead of the first real
    // prompt is one -- so the same question is asked here for the same reason.
    if (isHumanTurnStart(event)) event.humanTurn = true;
    return { result: { ...stateUpdates, event }, rawBlocks };
  };

  const plain = (): NormalizedCodexLine => finish('system', [{ block: plainBlock(ev), raw: stringifyForDisplay(ev) }]);

  // Both the top-level `compacted` record and the later
  // `event_msg.context_compacted` signal keep their own source-line banner.
  // The post-compaction token record reports the new smaller context.
  if (top === 'compacted') {
    return finish('system', [{ block: { kind: 'compaction' }, raw: null }]);
  }
  if (!p) return plain();

  if (top === 'event_msg') {
    const pe = p as EventMsgPayload;
    const eventType = typeof pe.type === 'string' ? pe.type : '';
    const label = CODEX_EVENT_LABELS[eventType];
    if (!label) return plain();
    const stateUpdates: Omit<LineResult, 'event'> = {};
    const closed = turnClosedFor(ev);
    if (closed !== undefined) stateUpdates.turnClosed = closed;
    if (eventType === 'agent_reasoning' && typeof pe.text === 'string' && pe.text.trim()) {
      return finish('reasoning', [{ block: { kind: 'reasoning', text: pe.text.trim() }, raw: pe.text }], stateUpdates);
    }
    if (eventType === 'context_compacted') {
      return finish('system', [{ block: { kind: 'compaction' }, raw: null }], stateUpdates);
    }
    if (eventType === 'patch_apply_end') {
      return finish('system', [{ block: patchAppliedBlock(pe, label), raw: null }], stateUpdates);
    }
    if (pe.type === 'token_count') {
      const lastUsage = pe.info?.last_token_usage;
      const last = typeof lastUsage?.total_tokens === 'number' ? lastUsage.total_tokens : 0;
      const cached = typeof lastUsage?.cached_input_tokens === 'number' ? lastUsage.cached_input_tokens : 0;
      const input = typeof lastUsage?.input_tokens === 'number' ? lastUsage.input_tokens : 0;
      if (last > 0) {
        // `current` is `total_tokens` as published: it already counts the
        // cached portion, because `input_tokens` includes it. The meter is the
        // prompt the model actually held, matching the Claude adapter's sum.
        const current = last;
        // No `model` on the usage: `token_count` does not name one, and Codex
        // needs no name to produce a limit -- it publishes the window itself,
        // and the published value is authoritative (three distinct windows
        // appear across this project's rollouts). The name lives on a separate
        // `turn_context` line, which carries no occupancy, so reaching it would
        // mean threading a second cross-line signal for a cosmetic label.
        // Leaving `model` absent also makes the session merge treat a
        // window-less record as "inherit", which is what the 124 such records
        // in this project need.
        const limit = typeof pe.info?.model_context_window === 'number'
          ? pe.info.model_context_window
          : null;
        const usage = { current, limit, updatedAt: ts || Date.now() };
        const text = limit ? `${current.toLocaleString()} / ${limit.toLocaleString()} tokens` : `${current.toLocaleString()} tokens`;
        // The `token_count` line is machinery, so this cacheHit is re-stamped
        // onto the turn's last text event by the read paths. `input` is the
        // full prompt: `input_tokens` already includes the cached portion, so
        // the fraction `cached / input` is the true cache-hit rate. Both
        // numbers must be present: a record with input but no cache field
        // predates the field (or drifted), and a fabricated 0% would read as
        // authoritative.
        const cacheHit = typeof lastUsage?.input_tokens === 'number'
          && typeof lastUsage?.cached_input_tokens === 'number'
          && input > 0 && cached >= 0
          ? { cached, input }
          : undefined;
        return finish('system', [{ block: metadataBlock(label, text), raw: null }], {
          usage,
          ...(cacheHit ? { cacheHit } : {}),
        });
      }
      return finish('system', [{ block: metadataBlock(label, metadataText(pe)), raw: null }]);
    }
    const summary = typeof pe.last_agent_message === 'string' && pe.last_agent_message.trim()
      ? pe.last_agent_message.trim()
      : metadataText(pe);
    return finish('system', [{ block: metadataBlock(label, summary), raw: null }], stateUpdates);
  }

  if (top !== 'response_item') {
    const label = typeof top === 'string' ? CODEX_TOP_LEVEL_LABELS[top] : undefined;
    if (!label) return plain();
    const cwd = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd.trim() : undefined;
    return finish('system', [{ block: metadataBlock(label, metadataText(p)), raw: null }], cwd ? { cwd } : {});
  }
  const pr = p as ResponseItemPayload;
  const itemId = typeof pr.id === "string" && pr.id ? pr.id : undefined;

  if (pr.type === 'message') {
    const blocks = normalizeMessageContent(pr.content);
    if (pr.role === 'assistant') {
      return finish('assistant', blocks, {}, itemId);
    }
    if (pr.role === 'user') {
      return finish('user', blocks, {}, itemId);
    }
    if (pr.role === 'developer' || pr.role === 'system') {
      const label = pr.role === 'developer' ? 'Developer Message' : 'System Message';
      return finish('system', blocks.map((entry) => entry.block.kind === 'text'
        ? { block: metadataBlock(label, entry.block.text), raw: entry.raw }
        : entry));
    }
    return plain();
  }

  if (pr.type === 'function_call' || pr.type === 'custom_tool_call') {
    const name = typeof pr.name === 'string' ? pr.name : '';
    const { input, raw } = parseArgs(pr.type === 'custom_tool_call' ? pr.input : pr.arguments);
    const callId = typeof pr.call_id === 'string' ? pr.call_id : undefined;
    return finish('assistant', [{
      block: {
          kind: 'tool_use',
          tool: name,
          summary: summarizeToolUse(name, input, raw),
          input,
          ...(callId ? { callId } : {}),
      },
      raw: null,
    }], {}, itemId);
  }

  if (pr.type === 'function_call_output' || pr.type === 'custom_tool_call_output') {
    const text = outputToString(pr.output);
    if (!text) return plain();
    const callId = typeof pr.call_id === 'string' ? pr.call_id : undefined;
    const block = makeToolResultBlock(text);
    return finish('user', [{ block: callId ? { ...block, callId } : block, raw: text }], {}, itemId);
  }

  if (pr.type === 'reasoning') {
    const text = extractReasoningText(pr);
    // Named rather than dumped. 81,905 reasoning items across this project's
    // rollouts carry no readable trace -- Codex exposes `summary` only when
    // configured to, and otherwise the record holds an end-to-end encrypted
    // `encrypted_content` blob. Sending that through `plainBlock` printed the
    // ciphertext as a Plain card, several KB of base64 per row, which is both
    // useless and the largest single thing in the raw view. The Raw JSON drawer
    // still has the exact line for anyone who wants it.
    if (!text) {
      return finish('system', [{
        block: metadataBlock('Reasoning', 'encrypted, no readable trace'),
        raw: null,
      }], {}, itemId);
    }
    return finish('reasoning', [{ block: { kind: 'reasoning', text }, raw: text }], {}, itemId);
  }

  if (pr.type === 'agent_message') {
    const text = typeof pr.message === 'string' ? pr.message : metadataText(pr);
    return finish('system', [{ block: metadataBlock('Agent Message', text), raw: null }]);
  }

  return plain();
}
