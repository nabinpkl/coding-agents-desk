import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeTerminalKey } from '../src/key-input.js';

test('encodes ordinary, shifted, control, and meta characters', () => {
  assert.equal(encodeTerminalKey('ansi-A', []), 'a');
  assert.equal(encodeTerminalKey('ansi-A', ['shift']), 'A');
  assert.equal(encodeTerminalKey('ansi-C', ['control']), '\x03');
  assert.equal(encodeTerminalKey('ansi-F', ['option']), '\x1bf');
  assert.equal(encodeTerminalKey('ansi-F', ['command']), '\x1bf');
  assert.equal(encodeTerminalKey('ansi-1', ['shift']), '!');
});

test('encodes terminal navigation against normal and application cursor modes', () => {
  assert.equal(encodeTerminalKey('up', [], false), '\x1b[A');
  assert.equal(encodeTerminalKey('up', [], true), '\x1bOA');
  assert.equal(encodeTerminalKey('left', ['control'], true), '\x1b[1;5D');
  assert.equal(encodeTerminalKey('right', ['option'], false), '\x1b[1;3C');
});

test('encodes terminal editing keys and rejects unknown codes', () => {
  assert.equal(encodeTerminalKey('escape', []), '\x1b');
  assert.equal(encodeTerminalKey('tab', ['shift']), '\x1b[Z');
  assert.equal(encodeTerminalKey('return', []), '\r');
  assert.equal(encodeTerminalKey('delete', []), '\x7f');
  assert.equal(encodeTerminalKey('delete', ['control']), '\x08');
  assert.equal(encodeTerminalKey('missing', []), null);
});
