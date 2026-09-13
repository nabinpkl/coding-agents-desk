import { expect, test } from 'bun:test';
import { claudeAdapter } from "@/transcripts/claude/claudeTranscript";
import { mergeUsage } from "@/transcripts/usageState";

function userLine(content: unknown): string {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-09-10T12:00:00.000Z',
    message: { role: 'user', content },
  });
}

test('a tool result with no text is still that call\'s result, not the reader\'s turn', () => {
  // An MCP call answers with `tool_reference` items rather than text. Before this, the
  // envelope became a Plain block with no callId: nothing to pair it with its tool call,
  // so it took a row of its own -- and a user line carrying neither text nor a result is
  // what the feed draws as the person's own message.
  const result = claudeAdapter.processLine(userLine([
    {
      type: 'tool_result',
      tool_use_id: 'toolu_mcp',
      content: [
        { type: 'tool_reference', tool_name: 'mcp__chrome__navigate' },
        { type: 'tool_reference', tool_name: 'mcp__chrome__computer' },
      ],
    },
  ]));

  const event = result?.event;
  expect(event).toBeDefined();
  expect(event!.blocks[0]).toEqual({
    kind: 'tool_result',
    preview: 'mcp__chrome__navigate\nmcp__chrome__computer',
    callId: 'toolu_mcp',
  });
  // The whole envelope stays reachable, so nothing is lost by not printing it.
  expect(event!.blocks.some((block) => block.kind === 'plain')).toBe(false);
});

test('a tool result that returned nothing keeps its pairing rather than its envelope', () => {
  const result = claudeAdapter.processLine(userLine([
    { type: 'tool_result', tool_use_id: 'toolu_empty', content: [] },
  ]));

  expect(result?.event?.blocks[0]).toEqual({
    kind: 'tool_result',
    preview: '',
    callId: 'toolu_empty',
  });
});

test('a tool result carrying text is untouched', () => {
  const result = claudeAdapter.processLine(userLine([
    {
      type: 'tool_result',
      tool_use_id: 'toolu_text',
      content: [{ type: 'text', text: 'ok' }],
    },
  ]));

  expect(result?.event?.blocks[0]).toEqual({
    kind: 'tool_result',
    preview: 'ok',
    callId: 'toolu_text',
  });
});

/** The boundary record as the CLI writes it, trimmed to the fields the adapter reads. */
function compactBoundary(metadata: Record<string, unknown> | null): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    timestamp: '2026-09-14T00:55:43.983Z',
    ...(metadata ? { compactMetadata: metadata } : {}),
  });
}

test('a compaction reports the context it dropped to, without waiting for the next turn', () => {
  // Measured on this project's largest session: the meter otherwise held the pre-compaction
  // number for a median of 356 seconds after the boundary, and once for 8.4 hours.
  const result = claudeAdapter.processLine(compactBoundary({
    trigger: 'manual',
    preTokens: 361_046,
    postTokens: 27_741,
    cumulativeDroppedTokens: 14_954_537,
  }));
  expect(result?.usage).toEqual({
    current: 27_741,
    limit: null,
    updatedAt: Date.parse('2026-09-14T00:55:43.983Z'),
  });
});

test('a compaction names no model, so the session keeps the window it already knew', () => {
  // Same path a Codex `token_count` and a Claude `<synthetic>` line take: `mergeUsage` inherits
  // the limit and model from the last line that named one, rather than blanking the meter.
  const result = claudeAdapter.processLine(compactBoundary({ postTokens: 20_864 }));
  expect(result?.usage?.model).toBeUndefined();
  expect(mergeUsage({ current: 299_522, limit: 1_000_000, updatedAt: 1, model: 'claude-opus-5' }, result!.usage!))
    .toEqual({ current: 20_864, limit: 1_000_000, updatedAt: expect.any(Number), model: 'claude-opus-5' });
});

test('a boundary carrying no metadata leaves the meter where it was', () => {
  // An older CLI, or a record shape that moves. Reporting zero would read as an emptied context.
  expect(claudeAdapter.processLine(compactBoundary(null))?.usage).toBeUndefined();
  expect(claudeAdapter.processLine(compactBoundary({ trigger: 'auto' }))?.usage).toBeUndefined();
  expect(claudeAdapter.processLine(compactBoundary({ postTokens: 0 }))?.usage).toBeUndefined();
});
