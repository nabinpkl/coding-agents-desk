import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { boundedUTF8, calculatePresentation, normalizeCapacity, SerializedOperations } from '../src/runtime-state.js';

test('capacity ignores zero layouts and clamps manager protocol bounds', () => {
  assert.equal(normalizeCapacity({ cols: 0, rows: 24 }), null);
  assert.deepEqual(normalizeCapacity({ cols: 900.8, rows: 400.2 }), { columns: 512, rows: 256 });
});

test('presentation fits while readable and crops around the cursor below the scale floor', () => {
  const fit = calculatePresentation({
    viewColumns: 100, viewRows: 40, sourceColumns: 100, sourceRows: 40,
    viewportWidth: 1000, viewportHeight: 400, cursorColumn: 0, cursorRow: 0,
  });
  assert.equal(fit.scale, 1);
  assert.equal(fit.cropped, false);

  const cropped = calculatePresentation({
    viewColumns: 40, viewRows: 20, sourceColumns: 100, sourceRows: 40,
    viewportWidth: 400, viewportHeight: 200, cursorColumn: 99, cursorRow: 39,
  });
  assert.equal(cropped.scale, 0.75);
  assert.equal(cropped.cropped, true);
  assert.ok(cropped.offsetX > 0);
  assert.ok(cropped.offsetY > 0);
});

test('input policy counts UTF-8 bytes rather than code units', () => {
  assert.equal(boundedUTF8('é', 2), true);
  assert.equal(boundedUTF8('é', 1), false);
});

test('renderer operations remain ordered and continue after a failed operation', async () => {
  const events = [];
  const queue = new SerializedOperations(error => events.push(`error:${error.message}`));
  queue.enqueue(async () => { events.push('begin'); await Promise.resolve(); events.push('end'); });
  queue.enqueue(() => { throw new Error('broken'); });
  await queue.enqueue(() => { events.push('recovered'); });
  assert.deepEqual(events, ['begin', 'end', 'error:broken', 'recovered']);
});

test('live output queues behind checkpoint completion instead of being dropped', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(source, /case 'output': write\(entry, message\.data\)/);
  assert.doesNotMatch(source, /case 'output': if \(!entry\.checkpointOpen\)/);
});
