// Codex durable records carry the same response-item id the live mirror keys
// its rows by, so the webview can hand a finished live tail off to the durable
// row instead of leaving a duplicate. These tests pin that contract at the
// adapter seam.

import { expect, test } from 'bun:test';
import { codexAdapter } from "@/transcripts/codex/codexTranscript";

test('codex assistant message records carry their item id as messageId', () => {
  const r = codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-08-08T18:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_004f4f8daa3fbfd7016a777439ef788197b5ef8514324f70e6',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello' }],
    },
  }));
  expect(r?.event?.messageId).toBe('msg_004f4f8daa3fbfd7016a777439ef788197b5ef8514324f70e6');
  expect(r?.event?.type).toBe('assistant');
});

test('codex user message records carry their item id as messageId', () => {
  const r = codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-08-08T18:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_019fe292-636d-7300-97ec-259ab6a3035b',
      role: 'user',
      content: [{ type: 'input_text', text: 'stream\n' }],
    },
  }));
  expect(r?.event?.messageId).toBe('msg_019fe292-636d-7300-97ec-259ab6a3035b');
  expect(r?.event?.type).toBe('user');
});

test('records without an item id carry no messageId', () => {
  const r = codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-08-08T18:00:02.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'no id' }],
    },
  }));
  expect(r?.event?.messageId).toBeUndefined();
});
