(function (root) {
  'use strict';

  var PROFILES = ['desktop', 'mobile'];
  var SIZING_MODES = ['viewer', 'custom', 'preset'];

  function validDimension(value) {
    return Number.isInteger(value) && value >= 1 && value <= 4096;
  }

  function evaluateCommand(current, retiredEpochs, command, targetTabId, generation) {
    if (!command || typeof command.hostEpoch !== 'string' || command.hostEpoch.length === 0
        || command.hostEpoch.length > 128 || !Number.isInteger(command.revision)
        || command.revision < 0 || typeof command.active !== 'boolean'
        || !Number.isInteger(command.generation) || command.generation < 0
        || (command.tabId != null && (!Number.isInteger(command.tabId) || command.tabId < 0))
        || retiredEpochs.has(command.hostEpoch)) {
      return { accepted: false };
    }
    var sameEpoch = current.hostEpoch === command.hostEpoch;
    if (sameEpoch && command.revision <= current.revision) return { accepted: false };
    if (command.tabId !== targetTabId || command.generation !== generation) {
      return { accepted: false };
    }
    if (command.active && (
      !PROFILES.includes(command.profile)
      || !SIZING_MODES.includes(command.sizing)
      || !validDimension(command.width)
      || !validDimension(command.height)
    )) return { accepted: false };
    if (!command.active && (
      command.profile != null || command.sizing != null
      || command.width != null || command.height != null
    )) return { accepted: false };

    var sameDesired = !current.error && ((!current.active && !command.active)
      || (current.active && command.active
        && current.profile === command.profile
        && current.sizing === command.sizing
        && current.requestedWidth === command.width
        && current.requestedHeight === command.height));
    return { accepted: true, sameEpoch: sameEpoch, sameDesired: sameDesired };
  }

  function deviceSettings(profile, width, height, mobileUserAgent) {
    var mobile = profile === 'mobile';
    return {
      metrics: {
        width: width,
        height: height,
        deviceScaleFactor: mobile ? 3 : 0,
        mobile: mobile,
      },
      touchEnabled: mobile,
      userAgent: mobile ? mobileUserAgent : null,
    };
  }

  var api = {
    validDimension: validDimension,
    evaluateCommand: evaluateCommand,
    deviceSettings: deviceSettings,
  };
  root.AgentDeskSourceViewport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
