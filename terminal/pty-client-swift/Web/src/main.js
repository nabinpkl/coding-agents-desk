import { Terminal } from '@agentdesk/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@agentdesk/xterm/css/xterm.css';
import './terminal.css';
import {
  focusPaneSnapshot, paneIds, selectedPaneId, validateSnapshot, visiblePaneIds,
} from './workspace-state.js';
import {
  base64FromBinary, boundedUTF8, bytesFromBase64, calculatePresentation,
  isAuthoritativeCapacity, normalizeCapacity, SerializedOperations, settledCapacity,
} from './runtime-state.js';
import { terminalOptions } from './terminal-options.js';

const protocolVersion = 1;
const maximumInputBytes = 64 * 1024;
const bridge = window.webkit?.messageHandlers?.ptyTerminal;
const root = document.querySelector('#terminal-workspace-root');
const tabStrip = document.querySelector('#terminal-tabs');
const stage = document.querySelector('#terminal-stage');
const drawer = document.querySelector('#terminal-session-drawer');
const announcer = document.querySelector('#terminal-announcer');
const terminals = new Map();
let workspace = null;
let nativeReady = false;

function post(type, payload = {}) {
  bridge?.postMessage({ version: protocolVersion, type, ...payload });
}

function emitInput(entry, data, binary = false) {
  if (!nativeReady || (binary ? data.length > maximumInputBytes : !boundedUTF8(data, maximumInputBytes))) return;
  flushViewport(entry, true);
  post(binary ? 'inputBinary' : 'input', {
    terminalId: entry.id,
    ...(binary ? { data: base64FromBinary(data) } : { data }),
  });
}

function makeButton(label, text, intent, paneId) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pane-action';
  button.setAttribute('aria-label', label);
  button.title = label;
  setIdentifier(button, `terminal-${intent}-${paneId}`);
  button.textContent = text;
  button.addEventListener('pointerdown', event => event.stopPropagation());
  button.addEventListener('click', event => {
    event.stopPropagation();
    post('workspaceIntent', { intent, paneId });
  });
  return button;
}

function setIdentifier(element, identifier) {
  element.id = identifier;
  element.dataset.axId = identifier;
}

function createPane(pane) {
  const element = document.createElement('section');
  element.className = 'terminal-pane';
  element.dataset.paneId = pane.paneId;
  setIdentifier(element, `terminal-pane-${pane.paneId}`);
  element.setAttribute('aria-label', pane.title || 'Terminal pane');
  element.dataset.synchronizing = 'true';

  const header = document.createElement('header');
  header.className = 'pane-header';
  const title = document.createElement('span');
  title.className = 'pane-title';
  title.textContent = pane.title || 'Terminal';
  header.append(title);
  if (workspace.profile === 'workspace') {
    header.append(
      makeButton('Split right', '↔', 'splitHorizontal', pane.paneId),
      makeButton('Split down', '↕', 'splitVertical', pane.paneId),
      makeButton('Close pane', '×', 'closePane', pane.paneId),
    );
  }

  const viewport = document.createElement('div');
  viewport.className = 'terminal-viewport';
  const canvas = document.createElement('div');
  canvas.className = 'terminal-canvas';
  const mount = document.createElement('div');
  mount.className = 'terminal-mount';
  canvas.append(mount);
  viewport.append(canvas);

  const footer = document.createElement('footer');
  footer.className = 'terminal-footer';
  const sync = document.createElement('span');
  sync.className = 'terminal-sync-status';
  setIdentifier(sync, `terminal-sync-status-${pane.paneId}`);
  sync.textContent = 'Synchronizing';
  const ownership = document.createElement('span');
  setIdentifier(ownership, `terminal-viewport-ownership-${pane.paneId}`);
  const source = document.createElement('span');
  setIdentifier(source, `terminal-source-size-${pane.paneId}`);
  const view = document.createElement('span');
  setIdentifier(view, `terminal-view-size-${pane.paneId}`);
  const history = document.createElement('span');
  setIdentifier(history, `terminal-session-history-truncated-${pane.paneId}`);
  footer.append(sync, ownership, source, view, history);
  element.append(header, viewport, footer);
  element.addEventListener('pointerdown', () => focusPane(pane.paneId, true), { passive: true });

  let entry = terminals.get(pane.terminalId);
  if (!entry) {
    const term = new Terminal(terminalOptions());
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mount);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch { /* DOM renderer remains the deterministic fallback. */ }
    entry = {
      id: pane.terminalId, paneId: pane.paneId, term, fit, element, viewport, canvas,
      sync, ownership, source, view, history,
      operations: new SerializedOperations(() => post('rendererFailure', { terminalId: pane.terminalId })),
      resizeTimer: null, resizeGeneration: 0, resizeObserver: null,
      settledDimensions: null, pendingViewportClaim: false,
      status: null, sourceColumns: 80, sourceRows: 24, checkpointOpen: false,
      lastPresentation: '', unsettledAttempts: 0,
    };
    terminals.set(entry.id, entry);
    term.onUserData(data => emitInput(entry, data));
    term.onBinary(data => emitInput(entry, data, true));
    term.onTitleChange(value => {
      if (!value.trim()) return;
      post('title', { terminalId: entry.id, title: value.slice(0, 512) });
    });
    term.onRender(() => updatePresentation(entry));
    term.registerLinkProvider({ provideLinks: (line, callback) => callback(linksForLine(term, line)) });
    entry.resizeObserver = new ResizeObserver(() => scheduleViewport(entry));
    entry.resizeObserver.observe(viewport);
  } else {
    entry.resizeObserver.disconnect();
    entry.paneId = pane.paneId;
    entry.element = element;
    entry.viewport = viewport;
    entry.canvas = canvas;
    entry.sync = sync;
    entry.ownership = ownership;
    entry.source = source;
    entry.view = view;
    entry.history = history;
    element.dataset.synchronizing = entry.checkpointOpen ? 'true' : 'false';
    mount.replaceWith(entry.term.element?.parentElement ?? mount);
    entry.resizeObserver.observe(viewport);
    entry.unsettledAttempts = 0;
    scheduleViewport(entry);
  }
  return element;
}

function linksForLine(term, line) {
  const text = term.buffer.active.getLine(line - 1)?.translateToString(true) ?? '';
  const regex = /https?:\/\/[^\s<>'"`]+/g;
  return [...text.matchAll(regex)].map(match => ({
    text: match[0], range: { start: { x: match.index + 1, y: line }, end: { x: match.index + match[0].length, y: line } },
    activate: (_, value) => post('openLink', { url: value }),
  }));
}

function createNode(node) {
  if (node.kind === 'pane') return createPane(node);
  const split = document.createElement('div');
  split.className = 'split';
  split.dataset.axis = node.axis;
  split.append(createNode(node.first), createNode(node.second));
  return split;
}

function renderWorkspace(snapshot) {
  if (!validateSnapshot(snapshot)) {
    post('diagnostic', { code: 'invalidWorkspaceSnapshot' });
    return;
  }
  workspace = snapshot;
  root.dataset.profile = snapshot.profile;
  const liveTerminalIds = new Set();
  for (const tab of snapshot.tabs) collectTerminalIds(tab.root, liveTerminalIds);
  for (const [id, entry] of terminals) {
    if (liveTerminalIds.has(id)) continue;
    clearTimeout(entry.resizeTimer);
    entry.resizeObserver.disconnect();
    entry.term.dispose();
    terminals.delete(id);
  }
  tabStrip.replaceChildren();
  for (const tab of snapshot.tabs) {
    const item = document.createElement('div');
    item.className = 'terminal-tab-item';
    item.role = 'presentation';
    item.dataset.selected = tab.id === snapshot.selectedTabId ? 'true' : 'false';
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'terminal-tab';
    select.role = 'tab';
    setIdentifier(select, `terminal-workspace-tab-${tab.id}`);
    select.setAttribute('aria-selected', tab.id === snapshot.selectedTabId ? 'true' : 'false');
    const label = document.createElement('span');
    label.className = 'terminal-tab-title';
    label.textContent = tab.title;
    select.append(label);
    select.addEventListener('click', () => post('workspaceIntent', { intent: 'selectTab', tabId: tab.id }));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'terminal-tab-close';
    setIdentifier(close, `terminal-workspace-close-tab-${tab.id}`);
    close.setAttribute('aria-label', `Close ${tab.title}`);
    close.title = `Close ${tab.title}`;
    close.textContent = '×';
    close.addEventListener('click', () => post('workspaceIntent', { intent: 'closeTab', tabId: tab.id }));
    item.append(select, close);
    tabStrip.append(item);
  }
  if (snapshot.profile === 'workspace') {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'workspace-action';
    setIdentifier(add, 'terminal-workspace-add-tab');
    add.setAttribute('aria-label', 'New terminal tab');
    add.textContent = '+';
    add.addEventListener('click', () => post('workspaceIntent', { intent: 'addTab' }));
    const sessions = add.cloneNode(true);
    setIdentifier(sessions, 'terminal-session-drawer-open');
    sessions.setAttribute('aria-label', 'Show PTY sessions');
    sessions.textContent = 'Sessions';
    sessions.addEventListener('click', () => post('workspaceIntent', { intent: 'showSessions' }));
    tabStrip.append(add, sessions);
  }
  const selected = snapshot.tabs.find(tab => tab.id === snapshot.selectedTabId);
  stage.replaceChildren(createNode(selected.root));
  applyFocusedPane(selected.focusedPaneId);
  requestAnimationFrame(() => {
    for (const entry of terminals.values()) updatePresentation(entry);
  });
}

function collectTerminalIds(node, result) {
  if (node.kind === 'pane') result.add(node.terminalId);
  else { collectTerminalIds(node.first, result); collectTerminalIds(node.second, result); }
}

function focusPane(paneId, claim) {
  const focusedWorkspace = workspace && focusPaneSnapshot(workspace, paneId);
  if (!focusedWorkspace) return;
  workspace = focusedWorkspace;
  applyFocusedPane(paneId);
  post('focus', { paneId, claim });
  const entry = [...terminals.values()].find(value => value.paneId === paneId);
  if (entry) {
    flushViewport(entry, claim);
    if (claim) entry.term.focus();
  }
}

function applyFocusedPane(paneId) {
  for (const entry of terminals.values()) entry.element.dataset.focused = entry.paneId === paneId ? 'true' : 'false';
}

function capacityLabel(capacity) {
  return capacity ? `${capacity.columns}x${capacity.rows}` : 'none';
}

function proposedDimensions(entry) {
  const prior = {
    width: entry.canvas.style.width, height: entry.canvas.style.height,
    left: entry.canvas.style.left, top: entry.canvas.style.top,
    transform: entry.canvas.style.transform,
  };
  entry.canvas.style.width = `${entry.viewport.clientWidth}px`;
  entry.canvas.style.height = `${entry.viewport.clientHeight}px`;
  entry.canvas.style.left = '0';
  entry.canvas.style.top = '0';
  entry.canvas.style.transform = 'none';
  const proposed = entry.fit.proposeDimensions();
  Object.assign(entry.canvas.style, prior);
  return normalizeCapacity(proposed);
}

function scheduleViewport(entry) {
  clearTimeout(entry.resizeTimer);
  entry.resizeGeneration += 1;
  const generation = entry.resizeGeneration;
  entry.resizeTimer = setTimeout(() => {
    const first = proposedDimensions(entry);
    requestAnimationFrame(() => {
      if (entry.resizeGeneration !== generation) return;
      const second = proposedDimensions(entry);
      const dimensions = settledCapacity(first, second);
      if (!dimensions) {
        // A pane opened while detached can measure zero forever. Report the raw numbers and keep
        // retrying for a bounded window instead of giving up silently.
        entry.unsettledAttempts += 1;
        if (entry.unsettledAttempts <= 3 || entry.unsettledAttempts % 8 === 0) {
          post('diagnostic', {
            code: `vp${entry.unsettledAttempts} f=${capacityLabel(first)} s=${capacityLabel(second)}`
              + ` px=${entry.viewport.clientWidth}x${entry.viewport.clientHeight}`
              + ` m=${entry.term.element?.isConnected ? 1 : 0}`,
          });
        }
        if (entry.unsettledAttempts <= 24 || isAuthoritativeCapacity(second)) scheduleViewport(entry);
        return;
      }
      entry.unsettledAttempts = 0;
      entry.settledDimensions = dimensions;
      if (publishViewport(entry, dimensions, entry.pendingViewportClaim)) {
        entry.pendingViewportClaim = false;
      }
    });
  }, 150);
  updatePresentation(entry);
}

function flushViewport(entry, claim) {
  entry.pendingViewportClaim ||= claim;
  if (!entry.settledDimensions) {
    scheduleViewport(entry);
    return;
  }
  if (publishViewport(entry, entry.settledDimensions, entry.pendingViewportClaim)) {
    entry.pendingViewportClaim = false;
  }
}

function publishViewport(entry, dimensions, claim) {
  if (!nativeReady || !workspace || !isAuthoritativeCapacity(dimensions)) return false;
  const active = visiblePaneIds(workspace).includes(entry.paneId);
  const focused = selectedPaneId(workspace) === entry.paneId;
  post('viewport', { terminalId: entry.id, active, claim: active && focused && claim, ...dimensions });
  entry.view.textContent = `View ${dimensions.columns}×${dimensions.rows}`;
  return true;
}

function updatePresentation(entry) {
  if (!entry.viewport.isConnected) return;
  const dimensions = proposedDimensions(entry);
  if (!dimensions) return;
  const metrics = calculatePresentation({
    viewColumns: dimensions.columns, viewRows: dimensions.rows,
    sourceColumns: entry.sourceColumns, sourceRows: entry.sourceRows,
    viewportWidth: entry.viewport.clientWidth, viewportHeight: entry.viewport.clientHeight,
    cursorColumn: entry.term.buffer.active.cursorX, cursorRow: entry.term.buffer.active.cursorY,
  });
  if (!metrics) return;
  entry.canvas.style.width = `${metrics.naturalWidth}px`;
  entry.canvas.style.height = `${metrics.naturalHeight}px`;
  entry.canvas.style.left = `${-metrics.offsetX}px`;
  entry.canvas.style.top = `${-metrics.offsetY}px`;
  entry.canvas.style.transform = `scale(${metrics.scale})`;
  const presentation = `${metrics.scale.toFixed(4)}:${metrics.cropped}`;
  if (presentation !== entry.lastPresentation) {
    entry.lastPresentation = presentation;
    post('presentation', { terminalId: entry.id, scale: metrics.scale, cropped: metrics.cropped });
  }
}

function enqueue(entry, operation) {
  entry.operations.enqueue(operation);
}

function write(entry, encoded) {
  enqueue(entry, () => new Promise(resolve => entry.term.write(bytesFromBase64(encoded), () => {
    updatePresentation(entry);
    resolve();
  })));
}

function receive(message) {
  if (!message || message.version !== protocolVersion) return;
  if (message.type === 'runtimeConfiguration') {
    nativeReady = true;
    post('ready');
    return;
  }
  if (message.type === 'workspaceSnapshot') {
    renderWorkspace(message.snapshot);
    return;
  }
  if (message.type === 'sessionDrawer') {
    renderDrawer(message.sessions ?? [], message.status ?? '');
    return;
  }
  if (message.type === 'fontSize') {
    const pointSize = Math.min(48, Math.max(8, Number(message.pointSize) || 14));
    for (const entry of terminals.values()) {
      entry.term.options.fontSize = pointSize;
      updatePresentation(entry);
      scheduleViewport(entry);
    }
    return;
  }
  if (message.type === 'paste') {
    const target = terminals.get(message.terminalId);
    if (target && boundedUTF8(message.text, maximumInputBytes)) {
      flushViewport(target, true);
      target.term.paste(message.text);
    }
    return;
  }
  const entry = terminals.get(message.terminalId);
  if (!entry) return;
  switch (message.type) {
    case 'checkpointBegin':
      entry.checkpointOpen = true;
      entry.element.dataset.synchronizing = 'true';
      entry.sourceColumns = message.columns;
      entry.sourceRows = message.rows;
      entry.sync.textContent = 'Synchronizing';
      entry.sync.dataset.ready = 'false';
      enqueue(entry, () => {
        entry.term.clear(); entry.term.reset(); entry.term.resize(message.columns, message.rows);
        updatePresentation(entry);
      });
      break;
    case 'checkpointChunk': write(entry, message.data); break;
    case 'checkpointEnd':
      enqueue(entry, () => {
        entry.checkpointOpen = false;
        entry.element.dataset.synchronizing = 'false';
        entry.sync.textContent = `Revision ${message.revision}`;
        entry.sync.dataset.ready = 'true';
        entry.history.textContent = message.historyTruncated ? 'History truncated' : '';
        announcer.textContent = `Terminal synchronized at revision ${message.revision}`;
      });
      break;
    case 'output': write(entry, message.data); break;
    case 'viewportStatus':
      entry.status = message;
      entry.sourceColumns = message.sourceColumns;
      entry.sourceRows = message.sourceRows;
      entry.ownership.textContent = message.isOwner ? 'Controls layout' : message.ownerClientId ? `Following ${message.ownerTitle || 'viewer'}` : 'Source frozen';
      entry.source.textContent = `Source ${message.sourceColumns}×${message.sourceRows}`;
      entry.view.textContent = `View ${message.viewColumns}×${message.viewRows}`;
      updatePresentation(entry);
      break;
    case 'status': entry.sync.textContent = message.text; break;
    case 'closed': entry.sync.textContent = 'Session closed'; break;
    default: break;
  }
}

function renderDrawer(sessions, status) {
  drawer.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = 'PTY sessions';
  drawer.append(heading);
  const message = document.createElement('p');
  message.textContent = status;
  drawer.append(message);
  for (const session of sessions.slice(0, 64)) {
    const row = document.createElement('div');
    row.className = 'drawer-row';
    const name = document.createElement('span');
    name.className = 'drawer-name';
    name.textContent = session.name;
    const open = document.createElement('button');
    open.type = 'button'; open.textContent = 'Open'; open.disabled = session.state !== 'running';
    open.addEventListener('click', () => post('workspaceIntent', { intent: 'openSession', sessionName: session.name }));
    row.append(name, open); drawer.append(row);
  }
  const close = document.createElement('button');
  close.type = 'button'; close.textContent = 'Done'; close.addEventListener('click', () => { drawer.hidden = true; });
  drawer.append(close); drawer.hidden = false; close.focus();
}

window.agentDeskTerminal = Object.freeze({ receive, flushViewport: () => {
  const entry = [...terminals.values()].find(value => workspace && selectedPaneId(workspace) === value.paneId);
  if (entry) scheduleViewport(entry);
}});

document.addEventListener('copy', event => {
  const entry = [...terminals.values()].find(value => value.term.hasSelection());
  if (!entry) return;
  event.preventDefault();
  post('clipboardWrite', { text: entry.term.getSelection().slice(0, 1024 * 1024) });
});

document.fonts.ready.then(() => post('fontReady'));
post('booted');
