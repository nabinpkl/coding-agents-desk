// One transcript line as the blocks a reader sees.
//
// Every line becomes exactly one normalized record: its class, its label, its blocks,
// and whatever it says about the turn. `processLine` and `extractBlockRaw` both read
// this, which is what keeps a block's index the same in the feed and in the Raw drawer.

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
  extractCompactionUsage,
  declaredModelIn,
  normalizeBlocks,
  timestampMs,
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

  // A message the person sent while a turn was running, which the CLI folded into that turn. It is
  // written only as this attachment -- no `user` record follows -- so it renders as the person's own
  // message rather than as a "Queued Command" row of fields. The CLI's own task notifications ride
  // the same subtype and stay metadata.
  const queued = queuedHumanPrompt(ev);
  if (queued !== null) {
    return normalizedRecord(line, { ...ev, type: 'user', message: { role: 'user', content: queued } });
  }

  if (typeof t === 'string' && t !== 'user' && t !== 'assistant') {
    if (t === 'system' && ev.subtype === 'compact_boundary') {
      const rawBlocks = appendCommon([{ block: { kind: 'compaction' }, raw: null }]);
      // The one record in a Claude transcript that reports occupancy without being a turn. It is
      // read here rather than left to the next assistant line because the whole point of the
      // reading is that the next assistant line may be hours away.
      const usage = extractCompactionUsage(ev, ts);
      return {
        result: {
          event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) },
          ...(usage ? { usage } : {}),
          ...(cwd ? { cwd } : {}),
        },
        rawBlocks,
      };
    }
    const label = t === 'attachment' ? attachmentLabel(ev) : CLAUDE_METADATA_LABELS[t];
    if (label) {
      // The model attachment renders as the metadata row it always did; what is new is that its
      // identity is read on the way past, because it is the only record that keeps the context
      // tier the run was given.
      const declaredModel = t === 'attachment' ? declaredModelIn(ev) : null;
      const titleCandidate = t === 'custom-title'
        ? [ev.customTitle, ev.title, ev.value].find((value) => typeof value === 'string' && value.trim()) as string | undefined
        : undefined;
      const text = titleCandidate?.trim() || metadataText(ev);
      const rawBlocks = appendCommon([{ block: metadataBlock(label, text), raw: null }]);
      return {
        result: {
          event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) },
          ...(titleCandidate ? { title: titleCandidate.trim() } : {}),
          ...(declaredModel ? { declaredModel } : {}),
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
  // showing the full summary as user prose. The summary rides the banner's
  // block as its text, for a reader who opens the banner to see what the
  // session now remembers.
  if (t === 'user' && ev.isCompactSummary === true) {
    const summary = compactSummaryText(message.content);
    const block: ActivityBlock = summary ? { kind: 'compaction', text: summary } : { kind: 'compaction' };
    const rawBlocks = appendCommon([{ block, raw: null }]);
    return { result: { event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) }, turnClosed: false, ...(cwd ? { cwd } : {}) }, rawBlocks };
  }

  const contentBlocks = commandOutputBlocks(message.content) ?? normalizeBlocks(message.content);
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
  const rawMessageId = typeof message.id === 'string' ? message.id.trim() : '';
  const event: ParsedLine = {
    ts,
    type: semanticType,
    blocks: rawBlocks.map(({ block }) => block),
    ...(rawMessageId ? { messageId: rawMessageId } : {}),
  };
  // Asked once, here, because this is where the blocks exist and the panel has no way to ask it
  // later: every envelope the harness writes arrives as `type: "user"` too. A line Claude marks
  // `isMeta` is its own whatever it says -- the caveat before a slash command, the size note on an
  // image a tool read, a Stop hook's feedback, a skill's preamble. Matched by text alone, the image
  // note `[Image: original 3200x1826, ...]` passed as prose and the pinned bar named it as the
  // reader's last message.
  if (ev.isMeta !== true && isHumanTurnStart(event)) event.humanTurn = true;
  const result: LineResult = { turnClosed, event };
  if (usage) result.usage = usage;
  if (t === 'assistant') {
    const cacheHit = extractClaudeCacheHit(message.usage);
    if (cacheHit) result.cacheHit = cacheHit;
  }
  if (cwd) result.cwd = cwd;
  return { result, rawBlocks };
}

/**
 * The prompt of a `queued_command` attachment a person sent, or null for anything else. Measured
 * 2026-10-18: a person's carries `commandMode: "prompt"` and `origin.kind: "human"`; the CLI's
 * task notifications carry `commandMode: "task-notification"`.
 */
function queuedHumanPrompt(ev: Record<string, unknown>): string | null {
  if (ev.type !== 'attachment') return null;
  const attachment = ev.attachment as Record<string, unknown> | undefined;
  if (attachment?.type !== 'queued_command' || attachment.commandMode !== 'prompt') return null;
  const origin = attachment.origin as Record<string, unknown> | undefined;
  return origin?.kind === 'human' && typeof attachment.prompt === 'string' && attachment.prompt.trim() ? attachment.prompt : null;
}

/** Strips SGR colour codes, which is all the CLI's own output ever carries. */
const SGR = /\u001b\[[0-9;]*m/g;

/** A compaction's summary as the one string it was written as, or null when it holds no text. */
function compactSummaryText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .flatMap((part) => {
      if (!part || typeof part !== 'object') return [];
      const record = part as Record<string, unknown>;
      return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
    })
    .join('\n')
    .trim();
  return text || null;
}

/**
 * A slash command's confirmation, as the one legible row it is.
 *
 * `/model` and `/compact` write their result back into the context wrapped in
 * `<local-command-stdout>` and painted with terminal dim codes, so the feed rendered
 * `<local-command-stdout>\u001b[2mCompacted \u001b[22m</local-command-stdout>` as if a person had
 * typed it. The wrapper and the paint are for the terminal it was already printed on; what is
 * left is a sentence -- `Compacted`, `Set model to claude-opus-5` -- and for `/model` it is the
 * only record in the transcript that the model changed at all, because that command never reaches
 * the model and so has no typed row of its own.
 *
 * A metadata row rather than prose, because it is the harness reporting, not the person speaking.
 * Returns null for everything else, which leaves the ordinary path untouched.
 */
function commandOutputBlocks(content: unknown): NormalizedClaudeBlock[] | null {
  if (typeof content !== "string") return null;
  const match = /^\s*<local-command-stdout>([\s\S]*)<\/local-command-stdout>\s*$/.exec(content);
  if (!match) return null;
  const text = match[1]!.replace(SGR, "").trim();
  // An empty one still gets a row: the command ran and said nothing, which is different from the
  // command not appearing, and the raw drawer is one click away either way.
  return [{ block: metadataBlock("Command", text || "(no output)"), raw: null }];
}
