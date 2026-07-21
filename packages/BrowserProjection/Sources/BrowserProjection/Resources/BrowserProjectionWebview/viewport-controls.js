(function () {
  'use strict';

  var MIN_DIMENSION = 1;
  var MAX_DIMENSION = 4096;
  var RESIZE_DEBOUNCE_MS = 150;
  var DESKTOP_PRESET = { width: 1440, height: 900 };
  var MOBILE_PRESET = { width: 390, height: 844 };
  var MIN_ZOOM = 0.5;
  var MAX_ZOOM = 4;
  var ZOOM_STEP = 0.25;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function validDimension(value) {
    return Number.isInteger(value) && value >= MIN_DIMENSION && value <= MAX_DIMENSION;
  }

  function createBrowserProjectionViewportControls(options) {
    var stage = options.stage;
    var root = options.root;
    var postIntent = options.postIntent;
    var state = {
      initialized: false,
      active: false,
      owner: false,
      platform: 'macos',
      profile: 'desktop',
      sizing: 'viewer',
      width: 1,
      height: 1
    };
    var source = { element: null, width: 0, height: 0 };
    var zoomMultiplier = 1;
    var panX = 0;
    var panY = 0;
    var resizeTimer = null;
    var customTimer = null;
    var lastViewportSignature = '';

    var desktopButton = document.getElementById('browser-projection-device-desktop');
    var mobileButton = document.getElementById('browser-projection-device-mobile');
    var widthInput = document.getElementById('browser-projection-viewport-width');
    var heightInput = document.getElementById('browser-projection-viewport-height');
    var applyButton = document.getElementById('browser-projection-viewport-apply');
    var resetButton = document.getElementById('browser-projection-viewport-reset');
    var zoomOutButton = document.getElementById('browser-projection-zoom-out');
    var zoomLevel = document.getElementById('browser-projection-zoom-level');
    var zoomInButton = document.getElementById('browser-projection-zoom-in');
    var zoomResetButton = document.getElementById('browser-projection-zoom-reset');
    var actualReadout = document.getElementById('browser-projection-viewport-actual');
    var ownerReadout = document.getElementById('browser-projection-viewport-owner');

    function measuredViewerSize() {
      if (stage.clientWidth <= 0 || stage.clientHeight <= 0) return null;
      return {
        width: clamp(Math.round(stage.clientWidth), MIN_DIMENSION, MAX_DIMENSION),
        height: clamp(Math.round(stage.clientHeight), MIN_DIMENSION, MAX_DIMENSION)
      };
    }

    function updateControlState() {
      desktopButton.setAttribute('aria-pressed', String(state.profile === 'desktop'));
      mobileButton.setAttribute('aria-pressed', String(state.profile === 'mobile'));
      widthInput.value = String(state.width);
      heightInput.value = String(state.height);
      ownerReadout.value = state.active ? (state.owner ? 'Source owner' : 'Viewer active') : 'Viewer inactive';
      zoomLevel.textContent = zoomMultiplier === 1 ? 'Fit' : Math.round(zoomMultiplier * 100) + '%';
      zoomLevel.setAttribute('aria-label', 'Projection zoom ' + (zoomMultiplier === 1 ? 'Fit' : Math.round(zoomMultiplier * 100) + ' percent'));
    }

    function sendViewerState(claim) {
      if (!validDimension(state.width) || !validDimension(state.height)) return;
      postIntent({
        kind: 'viewer-state',
        active: state.active,
        claim: Boolean(claim),
        profile: state.profile,
        sizing: state.sizing,
        width: state.width,
        height: state.height
      });
    }

    function claimOwnership() {
      if (state.active) sendViewerState(true);
    }

    function updateViewerDimensions(claim) {
      if (state.sizing !== 'viewer') return;
      var size = measuredViewerSize();
      if (!size) return;
      state.width = size.width;
      state.height = size.height;
      updateControlState();
      sendViewerState(claim);
    }

    function scheduleViewerDimensions() {
      applyTransform();
      if (state.sizing !== 'viewer' || !state.active) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        updateViewerDimensions(false);
      }, RESIZE_DEBOUNCE_MS);
    }

    function flushViewerDimensions() {
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      applyTransform();
      if (state.sizing === 'viewer' && state.active) updateViewerDimensions(false);
    }

    function setPreset(profile) {
      if (customTimer) {
        clearTimeout(customTimer);
        customTimer = null;
      }
      var preset = profile === 'mobile' ? MOBILE_PRESET : DESKTOP_PRESET;
      state.profile = profile;
      state.sizing = 'preset';
      state.width = preset.width;
      state.height = preset.height;
      updateControlState();
      sendViewerState(true);
    }

    function commitCustomDimensions() {
      var width = Number(widthInput.value);
      var height = Number(heightInput.value);
      if (!validDimension(width) || !validDimension(height)) {
        widthInput.setAttribute('aria-invalid', String(!validDimension(width)));
        heightInput.setAttribute('aria-invalid', String(!validDimension(height)));
        updateControlState();
        return;
      }
      widthInput.removeAttribute('aria-invalid');
      heightInput.removeAttribute('aria-invalid');
      state.sizing = 'custom';
      state.width = width;
      state.height = height;
      updateControlState();
      sendViewerState(true);
    }

    function scheduleCustomDimensions() {
      if (customTimer) clearTimeout(customTimer);
      customTimer = setTimeout(function () {
        customTimer = null;
        commitCustomDimensions();
      }, RESIZE_DEBOUNCE_MS);
    }

    function flushCustomDimensions() {
      if (customTimer) {
        clearTimeout(customTimer);
        customTimer = null;
      }
      commitCustomDimensions();
    }

    function resetToViewer() {
      if (customTimer) {
        clearTimeout(customTimer);
        customTimer = null;
      }
      state.sizing = 'viewer';
      updateViewerDimensions(true);
    }

    function setZoom(nextZoom) {
      zoomMultiplier = clamp(Math.round(nextZoom / ZOOM_STEP) * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM);
      if (zoomMultiplier <= 1) {
        panX = 0;
        panY = 0;
      }
      applyTransform();
      updateControlState();
    }

    function resetZoom() {
      zoomMultiplier = 1;
      panX = 0;
      panY = 0;
      applyTransform();
      updateControlState();
    }

    function fitScale() {
      if (!source.width || !source.height) return 1;
      return Math.min(
        (stage.clientWidth || 1) / source.width,
        (stage.clientHeight || 1) / source.height
      );
    }

    function clampPan(scale) {
      var displayedWidth = source.width * scale;
      var displayedHeight = source.height * scale;
      panX = clamp(panX, Math.min(0, stage.clientWidth - displayedWidth), 0);
      panY = clamp(panY, Math.min(0, stage.clientHeight - displayedHeight), 0);
    }

    function applyTransform() {
      if (!source.element || !source.width || !source.height) return;
      var scale = fitScale() * zoomMultiplier;
      clampPan(scale);
      source.element.style.width = source.width + 'px';
      source.element.style.height = source.height + 'px';
      source.element.style.transformOrigin = 'top left';
      source.element.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
    }

    function setSurface(element, width, height) {
      source = { element: element, width: width || 0, height: height || 0 };
      applyTransform();
    }

    function clearSurface(element) {
      if (!element || source.element === element) source = { element: null, width: 0, height: 0 };
    }

    function canPan() {
      return zoomMultiplier > 1 && source.element != null;
    }

    function panBy(dx, dy) {
      if (!canPan()) return false;
      panX += dx;
      panY += dy;
      applyTransform();
      return true;
    }

    function renderAppliedViewport(viewport) {
      if (!viewport || !viewport.active) {
        actualReadout.value = 'Source native';
        return;
      }
      var requested = String(viewport.requestedWidth || '?') + '×' + String(viewport.requestedHeight || '?');
      var actual = String(viewport.actualWidth || '?') + '×' + String(viewport.actualHeight || '?');
      actualReadout.value = viewport.error
        ? 'Viewport error: ' + viewport.error
        : 'Requested ' + requested + ', actual ' + actual;
    }

    function deliver(message) {
      if (message.t === 'projection-viewer-native') {
        var firstActivation = !state.initialized;
        state.initialized = true;
        state.active = Boolean(message.active);
        state.platform = message.platform === 'ios' ? 'ios' : 'macos';
        if (firstActivation) state.profile = state.platform === 'ios' ? 'mobile' : 'desktop';
        if (state.sizing === 'viewer') {
          var size = measuredViewerSize();
          if (!size) return true;
          state.width = size.width;
          state.height = size.height;
        }
        updateControlState();
        sendViewerState(Boolean(message.claim));
        return true;
      }
      if (message.t === 'projection-viewer-flush') {
        flushViewerDimensions();
        return true;
      }
      if (message.t === 'browser-viewer-status') {
        state.owner = Boolean(message.owner);
        state.active = Boolean(message.active);
        state.profile = message.profile;
        state.sizing = message.sizing;
        state.width = message.width;
        state.height = message.height;
        updateControlState();
        return true;
      }
      if (message.t === 'browser-state') {
        renderAppliedViewport(message.viewport);
        var viewport = message.viewport || {};
        var signature = [
          message.projectedWindowId,
          message.generation,
          viewport.revision,
          viewport.actualWidth,
          viewport.actualHeight,
          viewport.error
        ].join(':');
        if (signature !== lastViewportSignature) {
          lastViewportSignature = signature;
          resetZoom();
        }
      }
      return false;
    }

    desktopButton.addEventListener('click', function () { setPreset('desktop'); });
    mobileButton.addEventListener('click', function () { setPreset('mobile'); });
    widthInput.addEventListener('input', scheduleCustomDimensions);
    heightInput.addEventListener('input', scheduleCustomDimensions);
    widthInput.addEventListener('change', scheduleCustomDimensions);
    heightInput.addEventListener('change', scheduleCustomDimensions);
    applyButton.addEventListener('click', flushCustomDimensions);
    resetButton.addEventListener('click', resetToViewer);
    zoomOutButton.addEventListener('click', function () { setZoom(zoomMultiplier - ZOOM_STEP); });
    zoomInButton.addEventListener('click', function () { setZoom(zoomMultiplier + ZOOM_STEP); });
    zoomResetButton.addEventListener('click', resetZoom);
    root.addEventListener('pointerdown', function (event) {
      if (event.target instanceof Element
          && event.target.closest('#browser-projection-zoom-out, #browser-projection-zoom-in, #browser-projection-zoom-reset')) return;
      if (state.active) sendViewerState(true);
    }, { passive: true });
    new ResizeObserver(scheduleViewerDimensions).observe(stage);
    updateControlState();
    renderAppliedViewport(null);

    return {
      deliver: deliver,
      setSurface: setSurface,
      clearSurface: clearSurface,
      applyTransform: applyTransform,
      canPan: canPan,
      panBy: panBy,
      claimOwnership: claimOwnership,
      resetZoom: resetZoom,
      flushViewerDimensions: flushViewerDimensions
    };
  }

  window.createBrowserProjectionViewportControls = createBrowserProjectionViewportControls;
})();
