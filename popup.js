document.getElementById("toggle").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) {
    try { await chrome.tabs.sendMessage(tab.id, { type: "ANNOTATE_TOGGLE" }); } catch (e) { /* no content script */ }
  }
  window.close();
});

document.getElementById("copy").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) {
    try { await chrome.tabs.sendMessage(tab.id, { type: "ANNOTATE_COPY" }); } catch (e) { /* no content script */ }
  }
  window.close();
});

try {
  const b = window.AX_BUILD;
  if (b) document.getElementById("build").textContent =
    "build " + b.sha + (b.count !== "n/a" ? " #" + b.count : "") + " · v" + b.version + " · " + b.at;
} catch (e) { /* stamp missing */ }
