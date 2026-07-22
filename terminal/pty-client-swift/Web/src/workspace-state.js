import { boundedUTF8 } from './runtime-state.js';

export const workspaceLimits = Object.freeze({ tabs: 16, panes: 16 });

export function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.tabs)) return false;
  if (!['workspace', 'singleSession'].includes(snapshot.profile)) return false;
  if (snapshot.tabs.length < 1 || snapshot.tabs.length > workspaceLimits.tabs) return false;
  const paneIds = new Set();
  const terminalIds = new Set();
  const tabIds = new Set();
  for (const tab of snapshot.tabs) {
    if (!validId(tab.id) || tabIds.has(tab.id) || !validId(tab.focusedPaneId) || !validTitle(tab.title)) return false;
    tabIds.add(tab.id);
    const panesBeforeTab = new Set(paneIds);
    if (!walkNode(tab.root, paneIds, terminalIds)) return false;
    if (!paneIds.has(tab.focusedPaneId) || panesBeforeTab.has(tab.focusedPaneId)) return false;
  }
  if (snapshot.profile === 'singleSession' && (snapshot.tabs.length !== 1 || paneIds.size !== 1)) return false;
  return paneIds.size <= workspaceLimits.panes && tabIds.has(snapshot.selectedTabId);
}

export function paneIds(snapshot) {
  const result = [];
  for (const tab of snapshot.tabs) collectPanes(tab.root, result);
  return result;
}

export function selectedPaneId(snapshot) {
  return snapshot.tabs.find(tab => tab.id === snapshot.selectedTabId)?.focusedPaneId ?? null;
}

export function visiblePaneIds(snapshot) {
  const selected = snapshot.tabs.find(tab => tab.id === snapshot.selectedTabId);
  if (!selected) return [];
  const result = [];
  collectPanes(selected.root, result);
  return result;
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && boundedUTF8(value, 128);
}

function validTitle(value) {
  return typeof value === 'string' && value.length > 0 && boundedUTF8(value, 256);
}

function walkNode(node, paneIds, terminalIds) {
  if (!node || typeof node !== 'object') return false;
  if (node.kind === 'pane') {
    if (!validId(node.paneId) || !validId(node.terminalId) ||
        paneIds.has(node.paneId) || terminalIds.has(node.terminalId)) return false;
    paneIds.add(node.paneId);
    terminalIds.add(node.terminalId);
    return validTitle(node.title);
  }
  if (node.kind !== 'split' || !['horizontal', 'vertical'].includes(node.axis)) return false;
  return walkNode(node.first, paneIds, terminalIds) && walkNode(node.second, paneIds, terminalIds);
}

function collectPanes(node, result) {
  if (node.kind === 'pane') result.push(node.paneId);
  else {
    collectPanes(node.first, result);
    collectPanes(node.second, result);
  }
}
