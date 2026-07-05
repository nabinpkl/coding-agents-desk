// Action popup (ADR-0042): shows whether the active tab is being mirrored and toggles it. With a
// default_popup the toolbar click opens this instead of firing chrome.action.onClicked, so the
// start/stop control lives here; the Alt+Shift+M command still toggles directly in the worker.
// The worker owns the truth (recordingTabId); this popup only queries and asks it to toggle.
const dot = document.getElementById('dot');
const statusEl = document.getElementById('status');
const subEl = document.getElementById('sub');
const btn = document.getElementById('toggle');
const verEl = document.getElementById('ver');
const fidelityRow = document.getElementById('fidelity-row');
const fidelityBox = document.getElementById('fidelity');

// Which build is loaded (ADR-0043 versioning). The marketing version always comes from the manifest;
// the exact git identity comes from build-info.json, which `just ext-stamp` regenerates and reload
// picks up (an unpacked extension runs whatever is on disk, so the sha is the only reliable "which
// build" signal). Reads as "v0.2.0 (128) 4ba5e8a"; a yellow "dirty" marks uncommitted edits at stamp
// time. Unstamped (no build-info.json) shows just the manifest version.
async function renderVersion() {
  const ver = chrome.runtime.getManifest().version;
  try {
    const info = await (await fetch(chrome.runtime.getURL('build-info.json'))).json();
    verEl.textContent = `v${info.version || ver} (${info.commits}) ${info.sha}`;
    if (info.dirty) {
      const tag = document.createElement('span');
      tag.className = 'dirty';
      tag.textContent = ' dirty';
      verEl.appendChild(tag);
    }
  } catch (e) {
    verEl.textContent = `v${ver} · unstamped`;
  }
}

function render(state) {
  const rec = !!(state && state.recording);
  const canRecord = !state || state.canRecord !== false;
  dot.classList.toggle('on', rec);
  statusEl.textContent = rec ? 'Mirroring this tab' : 'Not mirroring';
  subEl.textContent = (state && state.title) || '';
  btn.className = rec ? 'stop' : 'start';
  btn.disabled = !rec && !canRecord;
  btn.textContent = rec ? 'Stop mirroring' : (canRecord ? 'Start mirroring' : 'Not available on this page');
  // ADR-0044 Tier B: the high-fidelity (CDP) toggle only applies while mirroring this tab.
  fidelityRow.hidden = !rec;
  fidelityBox.checked = !!(state && state.fidelity);
}

async function refresh() {
  try { render(await chrome.runtime.sendMessage({ type: 'agentdesk-popup-query' })); }
  catch (e) { statusEl.textContent = 'Extension not ready'; btn.textContent = '—'; }
}

btn.addEventListener('click', async () => {
  btn.disabled = true;
  try { render(await chrome.runtime.sendMessage({ type: 'agentdesk-popup-toggle' })); }
  catch (e) { await refresh(); }
});

fidelityBox.addEventListener('change', async () => {
  try { render(await chrome.runtime.sendMessage({ type: 'agentdesk-popup-fidelity', on: fidelityBox.checked })); }
  catch (e) { await refresh(); }
});

refresh();
renderVersion();
