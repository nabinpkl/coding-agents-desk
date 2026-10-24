// The panel's service worker: web push and nothing else.
//
// No `fetch` handler, on purpose. This origin is a live Vite server; a worker that cached responses
// would serve a reader yesterday's panel. Registered from `features/profile/webPush.ts`.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Every push shows a notification: Chrome and iOS both penalise one that does not, and iOS can
// withdraw the permission. Whether to notify at all is decided by the sidecar before it sends.
//
// `renotify` makes a notification that replaces one with the same tag alert again (banner and sound)
// rather than update it silently. The sidecar gives each push its own tag, so this covers a repeat.
// It needs a tag: `showNotification` throws on `renotify` without one.
self.addEventListener("push", (event) => {
  const message = event.data ? event.data.json() : {};
  const title = typeof message.title === "string" ? message.title : "AgentDesk";
  const tag = typeof message.tag === "string" && message.tag ? message.tag : undefined;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof message.body === "string" ? message.body : "",
      tag,
      renotify: tag !== undefined,
      icon: "icons/icon-192.png",
      data: { url: typeof message.url === "string" ? message.url : "/" },
    }),
  );
});

// A tap brings back an open panel as it is, rather than navigating it and costing the reader every
// card's state; only when none is open does it open one at the notification's URL.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => "focus" in client);
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
