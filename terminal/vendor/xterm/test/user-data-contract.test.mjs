import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('fork exposes user-only input without replacing onData', async () => {
  const core = await readFile(new URL('../package/src/common/services/CoreService.ts', import.meta.url), 'utf8');
  const coreTerminal = await readFile(new URL('../package/src/common/CoreTerminal.ts', import.meta.url), 'utf8');
  const terminal = await readFile(new URL('../package/src/browser/public/Terminal.ts', import.meta.url), 'utf8');
  const typings = await readFile(new URL('../package/typings/xterm.d.ts', import.meta.url), 'utf8');

  assert.match(core, /if \(wasUserInput\)[\s\S]*_onUserData\.fire\(data\)/);
  assert.match(core, /_onData\.fire\(data\)/);
  assert.match(coreTerminal, /forward\(this\.coreService\.onUserData, this\._onUserData\)/);
  assert.match(terminal, /get onUserData\(\)[\s\S]*this\._core\.onUserData/);
  assert.match(typings, /onUserData: IEvent<string>/);
});

test('keyboard, IME, paste, selection and text mouse reports are marked as user input', async () => {
  const browser = await readFile(new URL('../package/src/browser/CoreBrowserTerminal.ts', import.meta.url), 'utf8');
  const composition = await readFile(new URL('../package/src/browser/input/CompositionHelper.ts', import.meta.url), 'utf8');
  const clipboard = await readFile(new URL('../package/src/browser/Clipboard.ts', import.meta.url), 'utf8');
  const selection = await readFile(new URL('../package/src/browser/services/SelectionService.ts', import.meta.url), 'utf8');
  const mouse = await readFile(new URL('../package/src/browser/services/MouseService.ts', import.meta.url), 'utf8');

  assert.match(browser, /triggerDataEvent\(result\.key, !wasModifierOnly\)/);
  assert.match(browser, /triggerDataEvent\(key, true\)/);
  assert.match(browser, /triggerDataEvent\(text, true\)/);
  assert.ok(allCallsAreUserInput(composition), 'every IME data event must carry user provenance');
  assert.match(clipboard, /triggerDataEvent\(text, true\)/);
  assert.match(selection, /triggerDataEvent\(sequence, true\)/);
  assert.match(mouse, /triggerBinaryEvent\(report\)/);
  assert.match(mouse, /triggerDataEvent\(report, true\)/);
});

test('parser, focus, color and cursor replies stay off the user-only event', async () => {
  const inputHandler = await readFile(new URL('../package/src/common/InputHandler.ts', import.meta.url), 'utf8');
  const browser = await readFile(new URL('../package/src/browser/CoreBrowserTerminal.ts', import.meta.url), 'utf8');

  assert.ok(dataEventCalls(inputHandler).length > 10, 'parser reply audit must cover the expected call sites');
  assert.ok(dataEventCalls(inputHandler).every(call => !call.endsWith(', true')));
  const browserReplies = dataEventCalls(browser).filter(call =>
    call.includes("C0.ESC + '[I'") ||
    call.includes("C0.ESC + '[O'") ||
    call.includes('${C0.ESC}]${ident}') ||
    call.includes('${C0.ESC}[4;') ||
    call.includes('${C0.ESC}[6;')
  );
  assert.ok(browserReplies.length >= 5, 'browser reply audit must cover focus, color and cell-size reports');
  assert.ok(browserReplies.every(call => !call.endsWith(', true')));
});

function dataEventCalls(source) {
  return [...source.matchAll(/triggerDataEvent\((.*?)\);/gs)]
    .map(match => match[1].replace(/\s+/g, ' ').trim());
}

function allCallsAreUserInput(source) {
  const calls = dataEventCalls(source);
  return calls.length > 0 && calls.every(call => call.endsWith(', true'));
}
