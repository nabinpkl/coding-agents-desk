/* Dev builds only, injected into the content script by `build.ts --watch`.
 * After an extension reload this tab's content script is orphaned. Before
 * reloading, the worker asks each tab whether its page should be reloaded
 * too: yes where the panel is open (the page being worked on), never while
 * the comment form holds text. The new worker does the page reload. */
import type { TabMessage } from "../messages.ts";
import { HOST_ID } from "../content/panel.ts";

chrome.runtime.onMessage.addListener((msg: TabMessage, _sender, sendResponse) => {
  if (msg.type !== "dev-reload") return;
  const shadow = document.getElementById(HOST_ID)?.shadowRoot;
  const panelOpen = Boolean(shadow?.querySelector(".dock:not([hidden])"));
  const draft = shadow?.querySelector("textarea")?.value.trim();
  if (panelOpen && draft) console.warn("[hot-reload] extension reloaded; page kept because the comment form has text. Reload it after saving.");
  sendResponse(panelOpen && !draft);
});
