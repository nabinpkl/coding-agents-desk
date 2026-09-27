/* Dev builds only: `node extension/build.ts --watch` injects this into the
 * service worker; release builds never contain it. The watcher streams the id
 * of its latest build; when that differs from the id compiled into this
 * bundle, the extension is stale: ask each tab whether its page should follow
 * (see hot-reload-content.ts), remember the ones that said yes, and reload.
 * The NEW worker reloads those pages on startup; reloading them any earlier
 * races the extension reload and leaves the page with no content script at
 * all. Comparing ids
 * instead of reacting to a one-off "reload" event also covers a worker that
 * was asleep during the rebuild: it catches up on its next wake. fetch
 * streaming rather than EventSource, which service workers do not reliably
 * expose. */
import type { TabMessage } from "../messages.ts";

declare const __DEV_BUILD_ID__: string;
declare const __DEV_RELOAD_URL__: string;

const TABS_TO_RELOAD = "devTabsToReload";

async function reloadExtension(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const ids = await Promise.all(
    tabs.map(async (t) => {
      if (t.id == null) return null;
      // Tabs without the content script reject; they are not ours to reload.
      const wants: unknown = await chrome.tabs.sendMessage(t.id, { type: "dev-reload" } satisfies TabMessage).catch(() => false);
      return wants === true ? t.id : null;
    }),
  );
  await chrome.storage.local.set({ [TABS_TO_RELOAD]: ids.filter((id) => id !== null) });
  chrome.runtime.reload();
}

async function reloadMarkedTabs(): Promise<void> {
  const ids: unknown = (await chrome.storage.local.get(TABS_TO_RELOAD))[TABS_TO_RELOAD];
  if (!Array.isArray(ids)) return;
  await chrome.storage.local.remove(TABS_TO_RELOAD);
  // A tab closed in the meantime rejects; nothing to do for it.
  await Promise.all(ids.map((id: number) => chrome.tabs.reload(id).catch(() => undefined)));
}

async function listen(): Promise<void> {
  const res = await fetch(__DEV_RELOAD_URL__);
  if (!res.ok || !res.body) throw new Error(`hot reload stream answered ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffered += value;
    const events = buffered.split("\n\n");
    buffered = events.pop() ?? "";
    for (const event of events) {
      const id = event.replace(/^data: /, "").trim();
      if (id && id !== __DEV_BUILD_ID__) {
        await reloadExtension();
        return;
      }
    }
  }
}

function connect(): void {
  listen().then(
    () => setTimeout(connect, 2000),
    () => setTimeout(connect, 2000),
  );
}

console.log(`[hot-reload] dev build ${__DEV_BUILD_ID__}, watching ${__DEV_RELOAD_URL__}`);
// Chrome stops an idle MV3 worker after about 30 s, and an open fetch stream does
// not count as activity, so the watcher would lose it between saves. Any
// extension API call resets the idle timer; dev builds only.
setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);

void reloadMarkedTabs();
connect();
