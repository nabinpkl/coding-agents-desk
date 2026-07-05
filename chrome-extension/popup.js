// Action popup (ADR-0042): shows whether the active tab is being mirrored and toggles it. With a
// default_popup the toolbar click opens this instead of firing chrome.action.onClicked, so the
// start/stop control lives here; the Alt+Shift+M command still toggles directly in the worker.
// The worker owns the truth (recordingTabId); this popup only queries and asks it to toggle.
const dot = document.getElementById('dot');
const statusEl = document.getElementById('status');
const subEl = document.getElementById('sub');
const btn = document.getElementById('toggle');

function render(state) {
  const rec = !!(state && state.recording);
  const canRecord = !state || state.canRecord !== false;
  dot.classList.toggle('on', rec);
  statusEl.textContent = rec ? 'Mirroring this tab' : 'Not mirroring';
  subEl.textContent = (state && state.title) || '';
  btn.className = rec ? 'stop' : 'start';
  btn.disabled = !rec && !canRecord;
  btn.textContent = rec ? 'Stop mirroring' : (canRecord ? 'Start mirroring' : 'Not available on this page');
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

refresh();
