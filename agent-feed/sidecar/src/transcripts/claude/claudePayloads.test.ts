import { expect, test } from 'bun:test';
import { claudeAdapter } from "@/transcripts/claude/claudeTranscript";

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
