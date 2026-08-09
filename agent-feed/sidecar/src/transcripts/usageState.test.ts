import { expect, test } from 'bun:test';
import { mergeUsage } from './usageState.ts';
import { claudeAdapter } from './sources/claudeTranscript.ts';
import { codexAdapter } from './sources/codexTranscript.ts';

test('a report that names no model inherits the last known model and limit', () => {
  const first = mergeUsage(undefined, {
    current: 120_000,
    limit: 200_000,
    updatedAt: 1,
    model: 'claude-opus-5',
  });
  // 124 Codex token_count records in this project publish occupancy with no
  // window. Blanking the meter on those would make it flicker.
  const second = mergeUsage(first, { current: 130_000, limit: null, updatedAt: 2 });

  expect(second).toEqual({
    current: 130_000,
    limit: 200_000,
    updatedAt: 2,
    model: 'claude-opus-5',
  });
});

test('a named model owns its limit, including when that limit is unknown', () => {
  const previous = { current: 10, limit: 258_400, updatedAt: 1, model: 'gpt-5.5' };
  const switched = mergeUsage(previous, {
    current: 20,
    limit: null,
    updatedAt: 2,
    model: 'model-this-build-has-never-seen',
  });

  // Carrying the old window forward would render a fraction of the wrong
  // denominator, which reads as authoritative and is not.
  expect(switched.limit).toBeNull();
  expect(switched.model).toBe('model-this-build-has-never-seen');
});

test('occupancy is replaced, never accumulated, so replaying a line is a no-op', () => {
  const line = { current: 42_000, limit: 200_000, updatedAt: 7, model: 'claude-opus-5' };
  const once = mergeUsage(undefined, line);

  expect(mergeUsage(once, line)).toEqual(once);
});

test('a published window overrides the inherited one when the model changes', () => {
  const previous = { current: 10, limit: 258_400, updatedAt: 1 };

  expect(mergeUsage(previous, { current: 20, limit: 353_400, updatedAt: 2 }).limit)
    .toBe(353_400);
});

test('claude resolves the context window from the model on the line', () => {
  const result = claudeAdapter.processLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-29T12:00:00.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      usage: { input_tokens: 1_000, cache_read_input_tokens: 40_000, output_tokens: 500 },
      content: [{ type: 'text', text: 'done' }],
    },
  }));

  expect(result?.usage).toEqual({
    current: 41_500,
    limit: 200_000,
    updatedAt: Date.parse('2026-07-29T12:00:00.000Z'),
    model: 'claude-opus-5',
  });
});

test('claude assistant usage carries a per-turn cache hit badge', () => {
  const result = claudeAdapter.processLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-29T12:00:00.000Z',
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 1_000,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 2_000,
        output_tokens: 500,
      },
      content: [{ type: 'text', text: 'done' }],
    },
  }));

  // A hit is input served from the cache; `input` is the whole prompt,
  // including the portion written to cache this turn.
  expect(result?.cacheHit).toEqual({ cached: 40_000, input: 43_000 });
  // Usage-less assistant lines carry no badge.
  const plain = claudeAdapter.processLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-29T12:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'streaming' }],
    },
  }));
  expect(plain?.cacheHit).toBeUndefined();
});

test('claude cache badge is absent when usage reports no tokens at all', () => {
  const result = claudeAdapter.processLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-29T12:00:00.000Z',
    message: {
      role: 'assistant',
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: 'text', text: 'empty' }],
    },
  }));
  expect(result?.cacheHit).toBeUndefined();
});

test('a <synthetic> model reads as no model rather than an unknown one', () => {
  const result = claudeAdapter.processLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-29T12:00:00.000Z',
    message: {
      role: 'assistant',
      model: '<synthetic>',
      usage: { input_tokens: 5_000, output_tokens: 10 },
      content: [{ type: 'text', text: 'injected' }],
    },
  }));

  // Absent, not the literal string: the merge's inherit branch keys off exactly
  // this, and `<synthetic>` appears mid-stream rather than at a model switch.
  expect(result?.usage?.model).toBeUndefined();
  expect(result?.usage?.current).toBe(5_010);
});

test('codex carries the window the transcript published and names no model', () => {
  const result = codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-29T12:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { total_tokens: 88_000 },
        model_context_window: 258_400,
      },
    },
  }));

  expect(result?.usage).toEqual({
    current: 88_000,
    limit: 258_400,
    updatedAt: Date.parse('2026-07-29T12:00:00.000Z'),
  });
});

test('codex occupancy is total_tokens as published, which already counts cache', () => {
  const result = codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-29T12:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 5_000,
          cached_input_tokens: 3_000,
          total_tokens: 5_500,
        },
        model_context_window: 258_400,
      },
    },
  }));

  // `input_tokens` is the FULL prompt and already includes the cached portion
  // (verified against real rollouts: input - cached is the small fresh
  // remainder), so the meter is `total_tokens` unchanged and the hit rate is
  // cached / input = 3000 / 5000.
  expect(result?.usage?.current).toBe(5_500);
  expect(result?.cacheHit).toEqual({ cached: 3_000, input: 5_000 });
  // The record stays machinery: the badge is re-stamped onto the turn's last
  // text event by the read paths, never shown as its own nice-view row.
  expect(result?.lineClass).toBe('machinery');
});

test('codex token_count without cache fields reports no badge', () => {
  const result = codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-29T12:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 5_000, total_tokens: 5_500 } },
    },
  }));

  expect(result?.usage?.current).toBe(5_500);
  expect(result?.cacheHit).toBeUndefined();
});
