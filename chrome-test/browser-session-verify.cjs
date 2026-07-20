const assert = require('node:assert/strict');
const Session = require('../chrome-extension/browser-session.js');

function win(id, activeTabId, type = 'normal') {
  return {
    id,
    type,
    activeTabId,
    tabs: [
      { id: activeTabId, windowId: id, active: true, status: 'complete', url: `https://window-${id}.test/` },
      { id: activeTabId + 1, windowId: id, active: false, status: 'complete', url: `https://window-${id}.test/other` },
    ],
    groups: [],
  };
}

let state = Session.createSession();
state = { ...state, enabled: true };
state = Session.reconcile(state, [
  win(20, 200),
  win(10, 100),
  win(30, 300, 'popup'),
  win(31, 310, 'app'),
  win(32, 320, 'devtools'),
], 20);
assert.deepEqual(state.orderedWindowIds, [20, 10], 'only normal windows are session ordered');
assert.equal(state.projectedWindowId, 20, 'focused normal window is initially projected');
assert.equal(state.windows[0].ordinal, 1, 'first discovered window receives stable ordinal');
assert.equal(state.windows[1].ordinal, 2, 'second discovered window receives stable ordinal');
assert.deepEqual(state.recentlyFocusedWindowIds, [20], 'positive Chrome focus seeds focus recency');

const projected = Session.selectWindow(state, 10, state.generation);
assert.ok(projected, 'current-generation outer selection succeeds');
assert.equal(projected.focusedWindowId, 20, 'projection-only selection preserves Chrome focus');
assert.equal(projected.projectedWindowId, 10, 'projection-only selection changes projected window');
assert.equal(Session.selectWindow(state, 10, state.generation + 1), null, 'stale outer selection is rejected');
assert.equal(Session.validateTabSelection(projected, 10, 101, projected.generation), true, 'tab in projected window is selectable');
assert.equal(Session.validateTabSelection(projected, 20, 201, projected.generation), false, 'cross-window tab selection is rejected');
assert.equal(Session.selectWindow(Session.createSession(), 10, 0), null, 'window selection is rejected while projection is disabled');
assert.equal(Session.selectWindow(state, 999, state.generation), null, 'missing-window selection is rejected');

let focusHistory = Session.followFocusedWindow(state, 10);
focusHistory = Session.followFocusedWindow(focusHistory, 20);
focusHistory = Session.reconcile(focusHistory, [win(10, 100), win(40, 400)], null);
assert.equal(focusHistory.projectedWindowId, 10, 'closing the projected focus falls back to the most recently focused remaining window');

const target = Session.selectedTarget(projected);
state = Session.advanceGeneration(projected, target);
assert.equal(state.generation, 1, 'target transition advances generation');
assert.equal(state.targetTabId, 100, 'target transition selects the active tab of the projected window');
assert.equal(state.targetStatus, 'complete', 'target metadata records document readiness');
state = Session.withRecordedTab(state, 100);
assert.equal(Session.acceptsBatch(state, 100, 1), true, 'matching target batch is accepted');
assert.equal(Session.acceptsBatch(state, 200, 1), false, 'prior-window batch is rejected');
assert.equal(Session.acceptsBatch(state, 100, 0), false, 'stale-generation batch is rejected');

state = Session.reconcile(state, [win(10, 100), win(40, 400)], null);
assert.deepEqual(state.orderedWindowIds, [10, 40], 'removed windows disappear and new windows append');
assert.equal(state.windows[0].ordinal, 2, 'surviving window keeps its ordinal');
assert.equal(state.windows[1].ordinal, 3, 'new window gets the next ordinal');
assert.equal(Session.isRestrictedURL('chrome://version'), true);
assert.equal(Session.isRestrictedURL('https://example.com'), false);

const loadingTarget = Session.selectedTarget({
  ...state,
  windows: state.windows.map((window) => ({
    ...window,
    tabs: window.tabs.map((tab) => tab.id === window.activeTabId ? { ...tab, status: 'loading' } : tab),
  })),
});
const loading = Session.advanceGeneration(state, loadingTarget);
assert.equal(loading.generation, state.generation + 1, 'same-tab navigation can advance generation');
assert.equal(loading.targetStatus, 'loading', 'navigation target metadata records loading state');
const completed = Session.withTargetMetadata(loading, {
  window: loadingTarget.window,
  tab: { ...loadingTarget.tab, status: 'complete' },
});
assert.equal(completed.generation, loading.generation, 'completion metadata does not advance generation again');
assert.equal(completed.targetStatus, 'complete', 'completion arms the next same-URL navigation transition');

const restored = Session.restoreSession({
  enabled: true,
  focusedWindowId: 20,
  projectedWindowId: 10,
  generation: 9,
  orderedWindowIds: [20, 10, 20, -1, 'bad'],
  recentlyFocusedWindowIds: [10, 20, 99],
  ordinals: { 20: 1, 10: 2 },
  nextOrdinal: 3,
  recordedTabId: 100,
  targetWindowId: 10,
  targetTabId: 100,
  targetURL: 'https://window-10.test/',
  targetStatus: 'complete',
});
assert.equal(restored.enabled, true, 'MV3 session restore preserves enabled state');
assert.deepEqual(restored.orderedWindowIds, [20, 10], 'MV3 session restore sanitizes stable window order');
assert.deepEqual(restored.recentlyFocusedWindowIds, [10, 20], 'MV3 session restore preserves valid focus recency');
assert.equal(restored.projectedWindowId, 10, 'MV3 session restore preserves projected window');
assert.equal(restored.generation, 9, 'MV3 session restore preserves generation');
assert.equal(restored.recordedTabId, 100, 'MV3 session restore preserves recorder identity');

console.log('browser-session-verify: all checks passed');
