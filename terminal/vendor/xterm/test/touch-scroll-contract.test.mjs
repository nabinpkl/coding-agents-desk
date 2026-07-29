import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('touch gestures route through every terminal scrolling mode', async () => {
  const mouse = await readFile(new URL('../package/src/browser/services/MouseService.ts', import.meta.url), 'utf8');
  const viewport = await readFile(new URL('../package/src/browser/Viewport.ts', import.meta.url), 'utf8');

  assert.match(mouse, /register\(Gesture\.addTarget\(target\.screenElement\)\)/);
  assert.match(mouse, /GestureEventType\.START[\s\S]*_handleTouchStart/);
  assert.match(mouse, /GestureEventType\.CHANGE[\s\S]*_handleTouchChange/);
  assert.match(mouse, /requestedEvents\.wheel[\s\S]*_handleTouchScrollAsWheel/);
  assert.match(mouse, /!this\._bufferService\.buffer\.hasScrollback[\s\S]*_handleTouchScrollAsKeys/);
  assert.match(mouse, /ctx\.target\.handleTouchScroll\?\.\(e\.translationY\)/);
  assert.match(viewport, /handleTouchScroll\(translationY: number\)[\s\S]*scrollTop: pos\.scrollTop - translationY/);
});

test('touch inertia never emits mouse reports with invalid coordinates', async () => {
  const mouse = await readFile(new URL('../package/src/browser/services/MouseService.ts', import.meta.url), 'utf8');
  const touch = await readFile(new URL('../package/src/browser/scrollable/touch.ts', import.meta.url), 'utf8');

  assert.match(mouse, /!isFinite\(e\.clientX\) \|\| !isFinite\(e\.clientY\)/);
  assert.match(touch, /evt\.pageX = x \+ deltaPosX/);
  assert.match(touch, /evt\.pageY = y \+ deltaPosY/);
  assert.match(touch, /evt\.clientX = x \+ deltaPosX - targetWindow\.scrollX/);
  assert.match(touch, /evt\.clientY = y \+ deltaPosY - targetWindow\.scrollY/);
});
