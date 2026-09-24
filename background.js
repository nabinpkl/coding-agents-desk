/* MV3 service worker: relays popup toggle to the active tab. */
async function toggleActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "ANNOTATE_TOGGLE" });
  } catch (e) {
    // Tab has no content script (chrome:// pages, etc). Ignore.
  }
}

chrome.action.onClicked.addListener(toggleActiveTab);

chrome.commands.onCommand.addListener((command) => {
  console.log("[annotate-export] command fired:", command);
  if (command === "toggle-annotate") toggleActiveTab();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "ANNOTATE_SHOT") {
    const win = sender.tab ? sender.tab.windowId : undefined;
    chrome.tabs.captureVisibleTab(win, { format: "png" }).then((dataUrl) => {
      sendResponse({ dataUrl: dataUrl });
    }).catch(() => sendResponse({ error: "capture failed" }));
    return true;
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "ANNOTATE_COUNT" && sender.tab && sender.tab.id != null) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: String(msg.count || "") });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#c00" });
  }
});
