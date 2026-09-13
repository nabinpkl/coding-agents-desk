// One transcript line as the blocks a reader sees.
//
// Every line becomes exactly one normalized record: its class, its label, its blocks,
// and whatever it says about the turn. `processLine` and `extractBlockRaw` both read
// this, which is what keeps a block's index the same in the feed and in the Raw drawer.

import { isHarnessUserText } from "@/transcripts/humanTurns";
import type { ActivityBlock, LineResult, ParsedLine } from "@/transcripts/transcriptTypes";
import { isHumanTurnStart } from "@/transcripts/humanTurns";
import {
  metadataBlock,
  metadataText,
  plainBlock,
  plainEvent,
  rawBlock,
  stringifyForDisplay,
} from "@/transcripts/plainActivity";
import { classifyClaudeLine } from "@/transcripts/lineClass";
import {
  assistantModel,
  extractClaudeCacheHit,
  extractClaudeUsage,
  normalizeBlocks,
  timestampMs,
  truncate,
  turnClosedFor,
  type NormalizedClaudeBlock,
} from "@/transcripts/claude/claudePayloads";

export interface NormalizedClaudeLine {
  result: LineResult;
  rawBlocks: NormalizedClaudeBlock[];
}

// `attachment` is one record type carrying twenty unrelated things, and labelling
// them all `Attachment` is what made 978 `diagnostics` rows -- real type errors --
// indistinguishable from 4,891 rows of hook telemetry in this project's transcripts.
// The subtype is the label.
const CLAUDE_ATTACHMENT_LABELS: Readonly<Record<string, string>> = {
  diagnostics: 'Diagnostics',
  queued_command: 'Queued Command',
  edited_text_file: 'Edited File',
  file: 'File',
  compact_file_reference: 'Compacted File',
  structured_output: 'Structured Output',
  goal_status: 'Goal Status',
  nested_memory: 'Memory',
  plan_mode: 'Plan Mode',
  plan_mode_exit: 'Plan Mode Exit',
  plan_mode_reentry: 'Plan Mode Re-entry',
  plan_file_reference: 'Plan File',
  invoked_skills: 'Skills Invoked',
  task_status: 'Task Status',
  task_reminder: 'Task Reminder',
  async_hook_response: 'Hook',
  hook_success: 'Hook',
  hook_failure: 'Hook Failed',
  hook_additional_context: 'Hook Context',
  deferred_tools_delta: 'Deferred Tools',
  agent_listing_delta: 'Agent Listing',
  mcp_instructions_delta: 'MCP Instructions',
  command_permissions: 'Command Permissions',
  skill_listing: 'Skill Listing',
  date_change: 'Date Change',
  auto_mode: 'Auto Mode',
  max_turns_reached: 'Max Turns Reached',
  opened_file_in_ide: 'Opened In IDE',
};

/**
 * Label for one `attachment` record, from its subtype.
 *
 * An unmapped subtype keeps the subtype itself rather than collapsing back to
 * `Attachment`: a name we have not seen before is still more use than none, and a
 * future harness release adding one should read as unfamiliar, not as generic.
 */
function attachmentLabel(record: Record<string, unknown>): string {
  const attachment = record.attachment;
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
    return 'Attachment';
  }
  const subtype = (attachment as Record<string, unknown>).type;
  if (typeof subtype !== 'string' || !subtype) return 'Attachment';
  return CLAUDE_ATTACHMENT_LABELS[subtype] ?? `Attachment: ${subtype}`;
}

const CLAUDE_METADATA_LABELS: Readonly<Record<string, string>> = {
  attachment: 'Attachment',
  'last-prompt': 'Last Prompt',
  'custom-title': 'Title',
  mode: 'Mode',
  'queue-operation': 'Queue Operation',
  system: 'System',
  'permission-mode': 'Permission Mode',
  'file-history-snapshot': 'File History Snapshot',
};

export function normalizedLine(line: string): NormalizedClaudeLine | null {
  if (!line.trim()) return null;
  let ev: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { result: { event: plainEvent(line) }, rawBlocks: [{ block: plainBlock(line), raw: line }, { block: rawBlock(), raw: line }] };
    }
    ev = parsed as Record<string, unknown>;
  } catch {
    return { result: { event: plainEvent(line) }, rawBlocks: [{ block: plainBlock(line), raw: line }, { block: rawBlock(), raw: line }] };
  }
  const normalized = normalizedRecord(line, ev);
  // Stamped here, once, from the parsed record rather than the rendered blocks:
  // `normalizedRecord` returns from a dozen branches, and a new branch that
  // forgot this would silently leak a machinery row into the nice view. An
  // unparseable line above keeps the default, which is content -- we cannot tell
  // what it is, so it stays visible.
  normalized.result.lineClass = classifyClaudeLine(ev);
  return normalized;
}

export function normalizedRecord(
  line: string,
  ev: Record<string, unknown>,
): NormalizedClaudeLine {
  const t = ev.type;
  const cwd = typeof ev.cwd === 'string' && ev.cwd.trim() ? ev.cwd.trim() : undefined;
  const ts = timestampMs(ev.timestamp);

  const appendCommon = (blocks: NormalizedClaudeBlock[]): NormalizedClaudeBlock[] => {
    const next = [...blocks];
    if (cwd) next.push({ block: metadataBlock('Working Directory', cwd), raw: null });
    next.push({ block: rawBlock(), raw: line });
    return next;
  };

  // Claude harness writes (and rewrites) the session name as its own line
  // type. The bounded session probe keeps the latest observed title.
  if (t === 'ai-title') {
    const title = typeof ev.aiTitle === 'string' && ev.aiTitle.trim() ? ev.aiTitle.trim() : undefined;
    const rawBlocks = appendCommon(title
      ? [{ block: metadataBlock('Title', title), raw: null }]
      : [{ block: plainBlock(ev), raw: stringifyForDisplay(ev) }]);
    return {
      result: {
        event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) },
        ...(title ? { title } : {}),
        ...(cwd ? { cwd } : {}),
      },
      rawBlocks,
    };
  }

  if (typeof t === 'string' && t !== 'user' && t !== 'assistant') {
    if (t === 'system' && ev.subtype === 'compact_boundary') {
      const rawBlocks = appendCommon([{ block: { kind: 'compaction' }, raw: null }]);
      return {
        result: { event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) }, ...(cwd ? { cwd } : {}) },
        rawBlocks,
      };
    }
    const label = t === 'attachment' ? attachmentLabel(ev) : CLAUDE_METADATA_LABELS[t];
    if (label) {
      const titleCandidate = t === 'custom-title'
        ? [ev.customTitle, ev.title, ev.value].find((value) => typeof value === 'string' && value.trim()) as string | undefined
        : undefined;
      const text = titleCandidate?.trim() || metadataText(ev);
      const rawBlocks = appendCommon([{ block: metadataBlock(label, text), raw: null }]);
      return {
        result: {
          event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) },
          ...(titleCandidate ? { title: titleCandidate.trim() } : {}),
          ...(cwd ? { cwd } : {}),
        },
        rawBlocks,
      };
    }
    const rawBlocks = appendCommon([{ block: plainBlock(ev), raw: stringifyForDisplay(ev) }]);
    return {
      result: { event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) }, ...(cwd ? { cwd } : {}) },
      rawBlocks,
    };
  }

  if (t !== 'user' && t !== 'assistant') {
    const rawBlocks = appendCommon([{ block: plainBlock(ev), raw: stringifyForDisplay(ev) }]);
    return { result: { event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) }, ...(cwd ? { cwd } : {}) }, rawBlocks };
  }

  const message = ev.message && typeof ev.message === 'object' && !Array.isArray(ev.message)
    ? ev.message as Record<string, unknown>
    : {};

  // Compaction marker. The harness injects a synthetic user message with
  // `isCompactSummary: true` whose content is the summary that replaced
  // earlier turns in the model's view. Render as a single banner block so
  // the activity feed shows where the context was reset, instead of
  // showing the full summary as user prose.
  if (t === 'user' && ev.isCompactSummary === true) {
    const rawBlocks = appendCommon([{ block: { kind: 'compaction' }, raw: null }]);
    return { result: { event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) }, turnClosed: false, ...(cwd ? { cwd } : {}) }, rawBlocks };
  }

  const contentBlocks = normalizeBlocks(message.content);
  const stateBlocks: NormalizedClaudeBlock[] = [];
  const usage = t === 'assistant'
    ? extractClaudeUsage(message.usage, assistantModel(message), ts)
    : null;
  if (usage) stateBlocks.push({ block: metadataBlock('Token Usage', `${usage.current.toLocaleString()} tokens`), raw: null });
  if (typeof message.stop_reason === 'string' && message.stop_reason) {
    stateBlocks.push({ block: metadataBlock('Stop Reason', message.stop_reason), raw: null });
  }
  const rawBlocks = appendCommon([...contentBlocks, ...stateBlocks]);
  const semanticType = t === 'assistant' && contentBlocks.every(({ block }) => block.kind === 'reasoning')
    ? 'reasoning'
    : t;
  // Turn-boundary signal per line. `t` is user or assistant by here, so the rule
  // always has an answer; the `?? false` is for the type, not for a real case.
  const turnClosed = turnClosedFor(ev) ?? false;
  // The Anthropic message id the live `/v1/messages` stream also names on
  // `message_start`, so the viewer can hand a streaming live tail off to the
  // durable transcript once it contains this same id.
  const rawMessageId = typeof message.id === 'string' ? (message.id as string).trim() : '';
  const event: ParsedLine = {
    ts,
    type: semanticType,
    blocks: rawBlocks.map(({ block }) => block),
    ...(rawMessageId ? { messageId: rawMessageId } : {}),
  };
  // Asked once, here, because this is where the blocks exist and the panel has no way to ask it
  // later: every envelope the harness writes arrives as `type: "user"` too.
  if (isHumanTurnStart(event)) event.humanTurn = true;
  const result: LineResult = { turnClosed, event };
  if (usage) result.usage = usage;
  if (t === 'assistant') {
    const cacheHit = extractClaudeCacheHit(message.usage);
    if (cacheHit) result.cacheHit = cacheHit;
  }
  if (cwd) result.cwd = cwd;
  return { result, rawBlocks };
}
