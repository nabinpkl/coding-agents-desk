import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canRetainRenderedStage, focusPaneSnapshot, paneIds, selectedPaneId,
  validateSnapshot, visiblePaneIds,
} from '../src/workspace-state.js';

const snapshot = {
  version: 1,
  profile: 'workspace',
  selectedTabId: 'tab-1',
  tabs: [{
    id: 'tab-1',
    title: 'Terminal 1',
    focusedPaneId: 'pane-2',
    root: {
      kind: 'split', axis: 'horizontal',
      first: { kind: 'pane', paneId: 'pane-1', terminalId: 'terminal-1', title: 'one' },
      second: { kind: 'pane', paneId: 'pane-2', terminalId: 'terminal-2', title: 'two' },
    },
  }],
};

test('accepts a bounded recursive workspace snapshot', () => {
  assert.equal(validateSnapshot(snapshot), true);
  assert.deepEqual(paneIds(snapshot), ['pane-1', 'pane-2']);
  assert.deepEqual(visiblePaneIds(snapshot), ['pane-1', 'pane-2']);
  assert.equal(selectedPaneId(snapshot), 'pane-2');
});

test('rejects cross-tab focus and counts identifiers as UTF-8 bytes', () => {
  const secondTab = structuredClone(snapshot.tabs[0]);
  secondTab.id = 'tab-2';
  secondTab.root.first.paneId = 'pane-3';
  secondTab.root.first.terminalId = 'terminal-3';
  secondTab.root.second.paneId = 'pane-4';
  secondTab.root.second.terminalId = 'terminal-4';
  secondTab.focusedPaneId = 'pane-1';
  assert.equal(validateSnapshot({ ...snapshot, tabs: [...snapshot.tabs, secondTab] }), false);

  const oversized = structuredClone(snapshot);
  oversized.tabs[0].id = 'é'.repeat(65);
  oversized.selectedTabId = oversized.tabs[0].id;
  assert.equal(validateSnapshot(oversized), false);
});

test('rejects duplicate panes and absent selection', () => {
  const duplicate = structuredClone(snapshot);
  duplicate.tabs[0].root.second.paneId = 'pane-1';
  assert.equal(validateSnapshot(duplicate), false);
  assert.equal(validateSnapshot({ ...snapshot, selectedTabId: 'missing' }), false);
});

test('rejects duplicate terminal identities and invalid capability profiles', () => {
  const duplicate = structuredClone(snapshot);
  duplicate.tabs[0].root.second.terminalId = 'terminal-1';
  assert.equal(validateSnapshot(duplicate), false);
  assert.equal(validateSnapshot({ ...snapshot, profile: 'untrusted' }), false);
  assert.equal(validateSnapshot({ ...snapshot, profile: 'singleSession' }), false);
});

test('focus updates the selected pane without mutating the delivered snapshot', () => {
  const focused = focusPaneSnapshot(snapshot, 'pane-1');
  assert.equal(selectedPaneId(focused), 'pane-1');
  assert.equal(selectedPaneId(snapshot), 'pane-2');
  assert.equal(focusPaneSnapshot(snapshot, 'missing'), null);
});

test('retains the rendered stage only when the selected pane tree is unchanged', () => {
  const renamed = structuredClone(snapshot);
  renamed.tabs[0].title = 'Renamed';
  renamed.tabs[0].root.second.title = 'Shell';
  assert.equal(canRetainRenderedStage(snapshot, renamed), true);

  const splitChanged = structuredClone(snapshot);
  splitChanged.tabs[0].root.axis = 'vertical';
  assert.equal(canRetainRenderedStage(snapshot, splitChanged), false);

  assert.equal(canRetainRenderedStage(snapshot, { ...snapshot, profile: 'singleSession' }), false);

  const selectionChanged = { ...snapshot, selectedTabId: 'missing' };
  assert.equal(canRetainRenderedStage(snapshot, selectionChanged), false);
});
