import { extractReasoningText } from "@/transcripts/codex/codexReasoning";
import { isTracelessThinking } from "@/transcripts/claude/claudeThinking";
import type { LineClass } from "@/transcripts/transcriptTypes";

/**
 * Which transcript lines the nice view lets through.
 *
 * One rule decides it: a line is **machinery** when everything it would render is
 * a harness state dump, or a value that a later record of the same kind
 * supersedes. Everything else is **content** -- anything a person wrote, a model
 * produced, or a tool did.
 *
 * The polarity is deliberate. Machinery is an explicit deny-list and content is
 * the default, so a record type a future harness release invents shows up as an
 * unfamiliar row rather than silently vanishing. Getting that backwards is the one
 * failure this design cannot tolerate: the raw view is the fidelity guarantee, and
 * the nice view is only allowed to omit because a viewer can always fall back to
 * it, but neither helps if we omit something nobody knew existed.
 *
 * Measured on this project's transcripts, these rules remove 44 of the 100 rows in
 * a Codex tail window and 41 of 100 in a Claude one.
 */

/**
 * Claude top-level record types that carry only harness state.
 *
 * Every one of these renders today as a single metadata row holding a config dump:
 * the current mode, the last prompt echoed back, a file-backup bookkeeping entry,
 * the session's own name. None is the agent's working thread, and each is
 * superseded by the next record of its kind.
 */
const CLAUDE_MACHINERY_TYPES: ReadonlySet<string> = new Set([
  'mode',
  'permission-mode',
  'ai-title',
  'custom-title',
  'last-prompt',
  'queue-operation',
  'file-history-delta',
  'file-history-snapshot',
  'bridge-session',
  'agent-name',
  'worktree-state',
]);

/**
 * Claude `attachment` subtypes that carry only harness state.
 *
 * `attachment` is 9,787 rows in this project under a single `Attachment` label,
 * and 23.7 of its 35.8 MB is hook telemetry from two subtypes. Splitting by
 * subtype is what lets those go while the 978 `diagnostics` rows -- which carry
 * real type errors -- stay.
 */
const CLAUDE_MACHINERY_ATTACHMENTS: ReadonlySet<string> = new Set([
  'task_reminder',
  'hook_additional_context',
  'deferred_tools_delta',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'command_permissions',
  'date_change',
  'skill_listing',
]);

/**
 * Hook-result attachment subtypes, which are machinery ONLY when the hook
 * succeeded.
 *
 * A hook that exited non-zero is exactly the thing a viewer has to see, so the
 * exit code decides rather than the subtype. Every hook in this project's entire
 * history exited 0, which is why the failure case has never once appeared on
 * screen and why it is still the branch worth writing.
 */
const CLAUDE_HOOK_ATTACHMENTS: ReadonlySet<string> = new Set([
  'async_hook_response',
  'hook_success',
  'hook_failure',
]);

/**
 * Codex top-level record types that carry only harness state.
 *
 * These are the four the adapter already renders as a labelled config dump
 * (`Session Metadata`, `Turn Context`, `World State`, `Inter-agent
 * Communication`) -- 22,030 rows across this project's rollouts.
 */
const CODEX_MACHINERY_TOP_LEVEL: ReadonlySet<string> = new Set([
  'session_meta',
  'turn_context',
  'world_state',
  'inter_agent_communication_metadata',
]);

export function classifyClaudeLine(record: Record<string, unknown>): LineClass {
  const type = record.type;
  if (typeof type !== 'string') return 'content';

  if (type === 'attachment') {
    const attachment = record.attachment;
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      return 'content';
    }
    const subtype = (attachment as Record<string, unknown>).type;
    if (typeof subtype !== 'string') return 'content';
    if (CLAUDE_HOOK_ATTACHMENTS.has(subtype)) {
      const exitCode = (attachment as Record<string, unknown>).exitCode;
      return exitCode === 0 ? 'machinery' : 'content';
    }
    return CLAUDE_MACHINERY_ATTACHMENTS.has(subtype) ? 'machinery' : 'content';
  }

  // Claude's counterpart to Codex's encrypted reasoning: an assistant line whose
  // only content is a `thinking` block with an empty trace and a long opaque
  // signature, which renders today as a Plain card holding the blob. The text scan
  // is shared with the renderer so the two cannot disagree about which lines those
  // are. A line that ALSO holds prose or a tool call stays content.
  if (type === 'assistant') {
    const message = record.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      if (isTracelessThinking((message as Record<string, unknown>).content)) {
        return 'machinery';
      }
    }
  }

  return CLAUDE_MACHINERY_TYPES.has(type) ? 'machinery' : 'content';
}

export function classifyCodexLine(record: {
  type?: unknown;
  payload?: unknown;
}): LineClass {
  const top = record.type;
  if (typeof top !== 'string') return 'content';
  if (CODEX_MACHINERY_TOP_LEVEL.has(top)) return 'machinery';

  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'content';
  }
  const inner = (payload as Record<string, unknown>).type;

  // Occupancy left the transcript entirely: it is 143,407 rows across this
  // project's rollouts, every one supersedes the last, and it now renders as a
  // live header readout instead.
  if (top === 'event_msg' && inner === 'token_count') return 'machinery';

  // One message written twice. `event_msg.agent_message` is the notification as the
  // text is produced; the `response_item.message` assistant record that ALWAYS
  // follows it is the record of it. Across the six largest rollouts here, 6,934
  // pairs, 6,842 byte-identical (98.7%); in the 85 that differ the record is a
  // strict superset, and in none does the notification carry text the record lacks.
  //
  // Omitting it is a per-type rule about a duplicated stream, not dedup by content:
  // no line is compared to another, and the raw view still renders both. Worth doing
  // beyond the row count -- the notification renders as a DIM labelled row and the
  // record as bright prose, so today the same paragraph appears twice at two
  // weights.
  //
  // Scoped to the `event_msg` form. `response_item.agent_message` is a different
  // record (453 here against 72,324) and has not been shown to duplicate anything,
  // so it keeps the content default.
  if (top === 'event_msg' && inner === 'agent_message') return 'machinery';

  // A reasoning item whose trace is encrypted renders as the JSON of a Fernet
  // blob and says nothing. 81,905 rows / 7.2 MB here. The text check is shared
  // with the adapter so the two cannot disagree about which items those are.
  if (top === 'response_item' && inner === 'reasoning') {
    return extractReasoningText(payload as { summary?: unknown; content?: unknown })
      ? 'content'
      : 'machinery';
  }

  return 'content';
}
