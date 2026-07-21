const assert = require('node:assert/strict');
const SourceViewport = require('../chrome-extension/source-viewport.js');

const inactive = {
  active: false,
  hostEpoch: null,
  revision: 0,
  profile: null,
  sizing: null,
  requestedWidth: null,
  requestedHeight: null,
};
const mobileCommand = {
  hostEpoch: 'host-a',
  revision: 1,
  active: true,
  tabId: 22,
  generation: 7,
  profile: 'mobile',
  sizing: 'preset',
  width: 390,
  height: 844,
};

let result = SourceViewport.evaluateCommand(inactive, new Set(), mobileCommand, 22, 7);
assert.equal(result.accepted, true, 'current target accepts a bounded source request');
assert.equal(result.sameDesired, false, 'activation requires a generation-fenced source apply');

const active = {
  ...inactive,
  active: true,
  hostEpoch: 'host-a',
  revision: 1,
  profile: 'mobile',
  sizing: 'preset',
  requestedWidth: 390,
  requestedHeight: 844,
};
result = SourceViewport.evaluateCommand(active, new Set(), { ...mobileCommand, revision: 2 }, 22, 7);
assert.equal(result.sameDesired, true, 'target resends do not create a viewport generation loop');
result = SourceViewport.evaluateCommand({ ...active, error: 'debugger-detached' }, new Set(), { ...mobileCommand, revision: 2 }, 22, 7);
assert.equal(result.sameDesired, false, 'the next accepted request retries a failed viewport apply');
assert.equal(SourceViewport.evaluateCommand(active, new Set(), { ...mobileCommand, revision: 1 }, 22, 7).accepted, false, 'stale revision is rejected');
assert.equal(SourceViewport.evaluateCommand(active, new Set(['host-old']), { ...mobileCommand, hostEpoch: 'host-old' }, 22, 7).accepted, false, 'retired host epoch is rejected');
assert.equal(SourceViewport.evaluateCommand(active, new Set(), { ...mobileCommand, tabId: 23 }, 22, 7).accepted, false, 'stale tab target is rejected');
assert.equal(SourceViewport.evaluateCommand(active, new Set(), { ...mobileCommand, generation: 6 }, 22, 7).accepted, false, 'stale generation is rejected');
assert.equal(SourceViewport.evaluateCommand(inactive, new Set(), { ...mobileCommand, width: 0 }, 22, 7).accepted, false, 'zero width is rejected');
assert.equal(SourceViewport.evaluateCommand(inactive, new Set(), { ...mobileCommand, height: 4097 }, 22, 7).accepted, false, 'oversized height is rejected');
assert.equal(SourceViewport.evaluateCommand(inactive, new Set(), { ...mobileCommand, active: 'true' }, 22, 7).accepted, false, 'non-boolean activity is rejected');
assert.equal(SourceViewport.evaluateCommand(inactive, new Set(), { ...mobileCommand, generation: 7.5 }, 22, 7).accepted, false, 'non-integer generation is rejected');

const restored = SourceViewport.evaluateCommand(active, new Set(), {
  hostEpoch: 'host-a', revision: 3, active: false, tabId: 22, generation: 7,
  profile: null, sizing: null, width: null, height: null,
}, 22, 7);
assert.equal(restored.accepted, true, 'no-viewer request restores native source state');

assert.deepEqual(SourceViewport.deviceSettings('desktop', 1440, 900, 'mobile-ua'), {
  metrics: { width: 1440, height: 900, deviceScaleFactor: 0, mobile: false },
  touchEnabled: false,
  userAgent: null,
});
assert.deepEqual(SourceViewport.deviceSettings('mobile', 390, 844, 'mobile-ua'), {
  metrics: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  touchEnabled: true,
  userAgent: 'mobile-ua',
});

console.log('source-viewport-verify: all checks passed');
