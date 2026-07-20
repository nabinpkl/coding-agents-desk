(function (root) {
  'use strict';

  function createSession() {
    return {
      enabled: false,
      focusedWindowId: null,
      projectedWindowId: null,
      generation: 0,
      orderedWindowIds: [],
      recentlyFocusedWindowIds: [],
      ordinals: {},
      nextOrdinal: 1,
      windows: [],
      recordedTabId: null,
      targetWindowId: null,
      targetTabId: null,
      targetURL: null,
      targetStatus: null,
    };
  }

  function restoreSession(saved) {
    var session = createSession();
    if (!saved || saved.enabled !== true) return session;
    var ids = Array.isArray(saved.orderedWindowIds)
      ? saved.orderedWindowIds.filter(function (id, index, values) {
        return Number.isInteger(id) && id >= 0 && values.indexOf(id) === index;
      })
      : [];
    var recent = Array.isArray(saved.recentlyFocusedWindowIds)
      ? saved.recentlyFocusedWindowIds.filter(function (id, index, values) {
        return ids.includes(id) && values.indexOf(id) === index;
      })
      : [];
    var ordinals = {};
    ids.forEach(function (id) {
      var ordinal = saved.ordinals && saved.ordinals[id];
      if (Number.isInteger(ordinal) && ordinal > 0) ordinals[id] = ordinal;
    });
    var highestOrdinal = Object.values(ordinals).reduce(function (highest, ordinal) {
      return Math.max(highest, ordinal);
    }, 0);
    function restoredId(value) {
      return Number.isInteger(value) && value >= 0 ? value : null;
    }
    return Object.assign({}, session, {
      enabled: true,
      focusedWindowId: restoredId(saved.focusedWindowId),
      projectedWindowId: restoredId(saved.projectedWindowId),
      generation: Number.isInteger(saved.generation) && saved.generation >= 0 ? saved.generation : 0,
      orderedWindowIds: ids,
      recentlyFocusedWindowIds: recent,
      ordinals: ordinals,
      nextOrdinal: Number.isInteger(saved.nextOrdinal) && saved.nextOrdinal > highestOrdinal
        ? saved.nextOrdinal
        : highestOrdinal + 1,
      recordedTabId: restoredId(saved.recordedTabId),
      targetWindowId: restoredId(saved.targetWindowId),
      targetTabId: restoredId(saved.targetTabId),
      targetURL: typeof saved.targetURL === 'string' ? saved.targetURL : null,
      targetStatus: typeof saved.targetStatus === 'string' ? saved.targetStatus : null,
    });
  }

  function reconcile(session, windows, focusedWindowId) {
    var normal = windows.filter(function (window) { return window && window.type === 'normal'; });
    var present = new Set(normal.map(function (window) { return window.id; }));
    var ordered = session.orderedWindowIds.filter(function (id) { return present.has(id); });
    var ordinals = Object.assign({}, session.ordinals);
    var nextOrdinal = session.nextOrdinal;

    normal.forEach(function (window) {
      if (!ordered.includes(window.id)) ordered.push(window.id);
      if (ordinals[window.id] == null) ordinals[window.id] = nextOrdinal++;
    });

    var byId = new Map(normal.map(function (window) { return [window.id, window]; }));
    var focused = present.has(focusedWindowId) ? focusedWindowId : session.focusedWindowId;
    if (!present.has(focused)) focused = null;
    var recentlyFocused = (session.recentlyFocusedWindowIds || []).filter(function (id) {
      return present.has(id);
    });
    if (focused != null) {
      recentlyFocused = [focused].concat(recentlyFocused.filter(function (id) { return id !== focused; }));
    }
    var projected = present.has(session.projectedWindowId)
      ? session.projectedWindowId
      : (focused != null
        ? focused
        : (recentlyFocused[0] == null ? (ordered[0] == null ? null : ordered[0]) : recentlyFocused[0]));

    return Object.assign({}, session, {
      focusedWindowId: focused,
      projectedWindowId: projected,
      orderedWindowIds: ordered,
      recentlyFocusedWindowIds: recentlyFocused,
      ordinals: ordinals,
      nextOrdinal: nextOrdinal,
      windows: ordered.map(function (id) {
        var window = byId.get(id);
        return Object.assign({}, window, { ordinal: ordinals[id], focused: id === focused });
      }),
    });
  }

  function followFocusedWindow(session, windowId) {
    if (!session.windows.some(function (window) { return window.id === windowId; })) return session;
    return Object.assign({}, session, {
      focusedWindowId: windowId,
      projectedWindowId: windowId,
      recentlyFocusedWindowIds: [windowId].concat(
        (session.recentlyFocusedWindowIds || []).filter(function (id) { return id !== windowId; })
      ),
    });
  }

  function selectWindow(session, windowId, expectedGeneration) {
    if (!session.enabled || expectedGeneration !== session.generation) return null;
    if (!session.windows.some(function (window) { return window.id === windowId; })) return null;
    return Object.assign({}, session, { projectedWindowId: windowId });
  }

  function validateTabSelection(session, windowId, tabId, expectedGeneration) {
    if (!session.enabled || expectedGeneration !== session.generation) return false;
    if (session.projectedWindowId !== windowId) return false;
    var window = session.windows.find(function (candidate) { return candidate.id === windowId; });
    return !!window && window.tabs.some(function (tab) { return tab.id === tabId; });
  }

  function selectedTarget(session) {
    var window = session.windows.find(function (candidate) {
      return candidate.id === session.projectedWindowId;
    });
    if (!window) return { window: null, tab: null };
    var tab = window.tabs.find(function (candidate) { return candidate.id === window.activeTabId; }) || null;
    return { window: window, tab: tab };
  }

  function advanceGeneration(session, target) {
    return Object.assign({}, session, {
      generation: session.generation + 1,
      targetWindowId: target.window ? target.window.id : null,
      targetTabId: target.tab ? target.tab.id : null,
      targetURL: target.tab ? target.tab.url : null,
      targetStatus: target.tab ? target.tab.status : null,
      recordedTabId: null,
    });
  }

  function withTargetMetadata(session, target) {
    return Object.assign({}, session, {
      targetWindowId: target.window ? target.window.id : null,
      targetTabId: target.tab ? target.tab.id : null,
      targetURL: target.tab ? target.tab.url : null,
      targetStatus: target.tab ? target.tab.status : null,
    });
  }

  function withRecordedTab(session, tabId) {
    return Object.assign({}, session, { recordedTabId: tabId });
  }

  function isRestrictedURL(url) {
    return !/^https?:/i.test(url || '');
  }

  function acceptsBatch(session, tabId, generation) {
    return session.enabled
      && session.recordedTabId === tabId
      && session.targetTabId === tabId
      && session.generation === generation;
  }

  var api = {
    createSession: createSession,
    restoreSession: restoreSession,
    reconcile: reconcile,
    followFocusedWindow: followFocusedWindow,
    selectWindow: selectWindow,
    validateTabSelection: validateTabSelection,
    selectedTarget: selectedTarget,
    advanceGeneration: advanceGeneration,
    withTargetMetadata: withTargetMetadata,
    withRecordedTab: withRecordedTab,
    isRestrictedURL: isRestrictedURL,
    acceptsBatch: acceptsBatch,
  };

  root.AgentDeskBrowserSession = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
