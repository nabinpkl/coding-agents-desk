import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';

const bridge = window.webkit?.messageHandlers?.terminalSpike;
const terminalIDs = ['tab-a', 'tab-b'];
const entries = new Map();
let selectedID = terminalIDs[0];
let nativeReady = false;

function post(message) {
  bridge?.postMessage(message);
}

function bytesFromBase64(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function setStatus(entry, text, kind = 'normal') {
  entry.status.textContent = text;
  entry.status.dataset.kind = kind;
}

function enqueueTerminalOperation(entry, operation) {
  entry.operationChain = entry.operationChain
    .then(operation)
    .catch((error) => {
      setStatus(entry, `Renderer operation failed: ${String(error)}`, 'error');
      post({ type: 'log', message: `${entry.id}: ${String(error)}` });
    });
}

function measuredDimensions(entry) {
  const proposed = entry.fit.proposeDimensions();
  if (!proposed || proposed.cols < 1 || proposed.rows < 1) {
    return null;
  }
  return {
    columns: Math.min(proposed.cols, 512),
    rows: Math.min(proposed.rows, 256),
  };
}

function applyMeasuredDimensions(entry) {
  const dimensions = measuredDimensions(entry);
  if (!dimensions) return null;
  entry.term.resize(dimensions.columns, dimensions.rows);
  entry.view.textContent = `View ${dimensions.columns}×${dimensions.rows}`;
  return dimensions;
}

function reportViewport(entry, active, claim) {
  const dimensions = applyMeasuredDimensions(entry);
  if (!dimensions || !nativeReady) return;
  post({
    type: 'viewport',
    terminalId: entry.id,
    active,
    claim: active && claim,
    ...dimensions,
  });
}

function scheduleResize(entry) {
  clearTimeout(entry.resizeTimer);
  entry.resizeTimer = setTimeout(() => {
    if (entry.id !== selectedID) return;
    reportViewport(entry, true, false);
  }, 150);
}

function createTerminal(id, index) {
  const pane = document.querySelector(`[data-terminal-pane="${id}"]`);
  const mount = pane.querySelector('.terminal-mount');
  const status = pane.querySelector('.terminal-status');
  const source = pane.querySelector('.terminal-source');
  const view = pane.querySelector('.terminal-view');
  const owner = pane.querySelector('.terminal-owner');
  const renderer = pane.querySelector('.terminal-renderer');
  const term = new Terminal({
    allowProposedApi: false,
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: 'SFMono-Regular, Menlo, Monaco, monospace',
    fontSize: 14,
    lineHeight: 1.08,
    scrollback: 2000,
    theme: {
      background: '#0b0e14',
      foreground: '#d8dee9',
      cursor: '#8fbcbb',
      selectionBackground: '#394b70aa',
      black: '#1b1d23',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(mount);

  let rendererName = 'browser fallback';
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      renderer.textContent = 'Renderer browser fallback after WebGL loss';
    });
    term.loadAddon(webgl);
    rendererName = 'webgl';
  } catch (error) {
    post({ type: 'log', message: `WebGL unavailable for ${id}: ${String(error)}` });
  }
  renderer.textContent = `Renderer ${rendererName}`;

  const entry = {
    id,
    index,
    term,
    fit,
    pane,
    status,
    source,
    view,
    owner,
    renderer,
    nextDataIsUserInput: false,
    suppressedReplies: 0,
    resizeTimer: null,
    operationChain: Promise.resolve(),
  };
  entries.set(id, entry);

  // xterm's public onData event combines genuine user input with terminal-generated
  // protocol replies. The Rust headless terminal is the one authoritative reply
  // writer, so this spike uses xterm's internal source signal to forward only user
  // input. This private seam is intentionally one of the spike's production risks.
  const coreService = term._core?.coreService;
  if (!coreService?.onUserInput) {
    throw new Error('xterm core user-input source signal is unavailable');
  }
  coreService.onUserInput(() => {
    entry.nextDataIsUserInput = true;
  });

  term.onData((data) => {
    const wasUserInput = entry.nextDataIsUserInput;
    entry.nextDataIsUserInput = false;
    if (!wasUserInput) {
      entry.suppressedReplies += 1;
      renderer.textContent = `Renderer ${rendererName} · suppressed replies ${entry.suppressedReplies}`;
      return;
    }
    post({ type: 'input', terminalId: id, data });
  });
  term.onBinary((data) => {
    const bytes = Uint8Array.from(data, character => character.charCodeAt(0));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    post({ type: 'input-base64', terminalId: id, data: btoa(binary) });
  });
  term.onTitleChange((title) => {
    const button = document.querySelector(`[data-terminal-tab="${id}"] .tab-title`);
    if (button && title.trim()) button.textContent = title;
  });
  new ResizeObserver(() => scheduleResize(entry)).observe(pane);
  return entry;
}

function selectTerminal(id, claim = true) {
  if (!entries.has(id)) return;
  const previousID = selectedID;
  selectedID = id;
  for (const entry of entries.values()) {
    const selected = entry.id === id;
    entry.pane.hidden = !selected;
    document.querySelector(`[data-terminal-tab="${entry.id}"]`)
      ?.setAttribute('aria-selected', selected ? 'true' : 'false');
  }
  if (nativeReady && previousID !== id) {
    const previous = entries.get(previousID);
    if (previous) reportViewport(previous, false, false);
  }
  requestAnimationFrame(() => {
    const selected = entries.get(id);
    reportViewport(selected, true, claim);
    if (claim) selected.term.focus();
  });
}

function writeManagerData(entry, encoded) {
  enqueueTerminalOperation(entry, () => new Promise((resolve) => {
    entry.term.write(bytesFromBase64(encoded), resolve);
  }));
}

function receive(message) {
  const entry = entries.get(message.terminalId);
  if (message.type === 'native-ready') {
    nativeReady = true;
    for (const current of entries.values()) {
      reportViewport(current, current.id === selectedID, current.id === selectedID);
    }
    return;
  }
  if (!entry) return;

  switch (message.type) {
    case 'checkpoint-begin':
      enqueueTerminalOperation(entry, () => {
        setStatus(entry, `Synchronizing checkpoint ${message.checkpointId}…`);
        // clear() before reset() removes scrollback, while the serialized operation
        // chain prevents pre-checkpoint writes from landing after the reset.
        entry.term.clear();
        entry.term.reset();
        entry.term.resize(message.columns, message.rows);
        entry.source.textContent = `Source ${message.columns}×${message.rows}`;
      });
      break;
    case 'checkpoint-chunk':
    case 'output':
      writeManagerData(entry, message.data);
      break;
    case 'checkpoint-end':
      enqueueTerminalOperation(entry, () => {
        setStatus(entry, `Revision ${message.revision}`);
      });
      break;
    case 'viewport-status':
      entry.source.textContent = `Source ${message.sourceColumns}×${message.sourceRows}`;
      entry.view.textContent = `View ${message.viewColumns}×${message.viewRows}`;
      entry.owner.textContent = message.isOwner
        ? 'Controls layout'
        : message.ownerClientId === 0
          ? 'Source frozen'
          : `Following ${message.ownerTitle || 'another viewer'}`;
      break;
    case 'status':
      setStatus(entry, message.text, 'warning');
      break;
    case 'closed':
      setStatus(entry, 'Session closed', 'error');
      break;
    default:
      break;
  }
}

function snapshot(terminalId, marker) {
  const entry = entries.get(terminalId);
  if (!entry) return null;
  const buffer = entry.term.buffer.active;
  const lines = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  }
  return {
    containsMarker: lines.join('\n').includes(marker),
    columns: entry.term.cols,
    rows: entry.term.rows,
  };
}

window.agentDeskTerminal = { receive, snapshot };

for (const button of document.querySelectorAll('[data-terminal-tab]')) {
  button.addEventListener('click', () => selectTerminal(button.dataset.terminalTab, true));
}

terminalIDs.forEach(createTerminal);
selectTerminal(selectedID, false);
requestAnimationFrame(() => {
  const dimensions = applyMeasuredDimensions(entries.get(selectedID));
  post({ type: 'ready', ...dimensions });
});
