(function (root) {
  'use strict';

  var extensionBuildPromise = null;
  var faviconCache = new Map();
  var allowedFaviconTypes = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/x-icon',
    'image/vnd.microsoft.icon',
  ]);

  function bytesToBase64(bytes) {
    var binary = '';
    var chunkSize = 0x8000;
    for (var index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  async function extensionBuildIdentity() {
    if (!extensionBuildPromise) {
      extensionBuildPromise = (async function () {
        var version = chrome.runtime.getManifest().version;
        try {
          var response = await fetch(chrome.runtime.getURL('build-info.json'));
          var info = await response.json();
          return {
            version: info.version || version,
            commits: Number.isInteger(info.commits) ? info.commits : null,
            sha: typeof info.sha === 'string' ? info.sha : null,
            dirty: !!info.dirty,
          };
        } catch (error) {
          return { version: version, commits: null, sha: null, dirty: null };
        }
      })();
    }
    return extensionBuildPromise;
  }

  async function faviconDataURL(tab) {
    var pageURL = tab.url || tab.pendingUrl || '';
    if (!pageURL || AgentDeskBrowserSession.isRestrictedURL(pageURL)) return null;
    if (faviconCache.has(pageURL)) return faviconCache.get(pageURL);
    if (faviconCache.size >= 2048) faviconCache.delete(faviconCache.keys().next().value);
    var task = (async function () {
      try {
        var url = new URL(chrome.runtime.getURL('/_favicon/'));
        url.searchParams.set('pageUrl', pageURL);
        url.searchParams.set('size', '32');
        var response = await fetch(url);
        var blob = await response.blob();
        if (!response.ok || !allowedFaviconTypes.has(blob.type) || blob.size > 16 * 1024) return null;
        var bytes = new Uint8Array(await blob.arrayBuffer());
        return 'data:' + blob.type + ';base64,' + bytesToBase64(bytes);
      } catch (error) {
        return null;
      }
    })();
    faviconCache.set(pageURL, task);
    return task;
  }

  async function normalizeTab(tab) {
    var url = tab.url || tab.pendingUrl || '';
    return {
      id: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      active: !!tab.active,
      pinned: !!tab.pinned,
      groupId: Number.isInteger(tab.groupId) ? tab.groupId : -1,
      // Chrome 150 reports discarded tabs as `unloaded`. Keep the native wire status bounded to
      // loading|complete; `discarded` is the authoritative signal for the explicit placeholder.
      status: tab.status === 'loading' ? 'loading' : 'complete',
      title: tab.title || url || 'Untitled',
      url: url,
      favIconDataURL: await faviconDataURL(tab),
      audible: !!tab.audible,
      muted: !!(tab.mutedInfo && tab.mutedInfo.muted),
      discarded: !!tab.discarded,
      restricted: AgentDeskBrowserSession.isRestrictedURL(url),
    };
  }

  async function enumerateNormalWindows() {
    var windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    return Promise.all(windows.map(async function (windowState) {
      var groups = [];
      try {
        groups = await chrome.tabGroups.query({ windowId: windowState.id });
      } catch (error) {
        console.warn('[agentdesk] tab-group enumeration failed', windowState.id, error && error.message);
      }
      var tabs = await Promise.all((windowState.tabs || []).map(normalizeTab));
      var active = tabs.find(function (tab) { return tab.active; }) || null;
      return {
        id: windowState.id,
        type: windowState.type,
        focused: !!windowState.focused,
        state: windowState.state || 'normal',
        left: Number.isInteger(windowState.left) ? windowState.left : null,
        top: Number.isInteger(windowState.top) ? windowState.top : null,
        width: Number.isInteger(windowState.width) ? windowState.width : null,
        height: Number.isInteger(windowState.height) ? windowState.height : null,
        activeTabId: active ? active.id : null,
        tabs: tabs,
        groups: groups.map(function (group) {
          return {
            id: group.id,
            title: group.title || '',
            color: group.color || 'grey',
            collapsed: !!group.collapsed,
          };
        }),
      };
    }));
  }

  root.AgentDeskBrowserMetadata = {
    extensionBuildIdentity: extensionBuildIdentity,
    enumerateNormalWindows: enumerateNormalWindows,
  };
})(typeof self !== 'undefined' ? self : globalThis);
