const assert = require('node:assert/strict');

global.AgentDeskBrowserSession = require('../chrome-extension/browser-session.js');
global.chrome = {
  windows: {
    getAll: async () => [{
      id: 10,
      type: 'normal',
      focused: true,
      state: 'normal',
      tabs: [{
        id: 100,
        windowId: 10,
        index: 0,
        active: true,
        pinned: false,
        groupId: -1,
        status: 'unloaded',
        title: 'Discarded tab',
        url: 'https://discarded.example/',
        discarded: true,
      }],
    }],
  },
  tabGroups: { query: async () => [] },
  runtime: { getURL: (path) => `chrome-extension://test${path}` },
};
global.fetch = async () => ({
  ok: false,
  blob: async () => ({ type: '', size: 0 }),
});

require('../chrome-extension/browser-metadata.js');

(async () => {
  const windows = await global.AgentDeskBrowserMetadata.enumerateNormalWindows();
  const tab = windows[0].tabs[0];

  assert.equal(tab.status, 'complete', 'Chrome unloaded status stays inside the extension boundary');
  assert.equal(tab.discarded, true, 'discarded remains the wire signal for the explicit placeholder');
  assert.equal(tab.restricted, false, 'a discarded web tab remains projectable after it is reloaded');
  console.log('browser-metadata-verify: all checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
