// The OpenCode Go meter as a shared, lazily polled source for `/api/limits`.
//
// A poll, and the reason is that nothing pushes this: the endpoint is a plain HTTP read, there is
// no header stream to observe (Claude's meters ride proxy-agent) and no file opencode writes.
// So it is kept as cheap as a poll can be: it runs ONLY while at least one reader is subscribed
// (`/api/limits/opencode-go`, opened by a mounted Go meter, i.e. an expanded Go session card),
// at no faster than a minute (`opencodeGoPollMs` enforces the floor), one request at a time, and
// it stops when the last reader leaves. With no key on this machine it never touches the network.

import type { VendorQuotas } from "@agentdesk/agent-feed-wire";
import { fetchGoQuotas } from "@/usage/opencodeGoQuota";

export interface OpencodeGoSource {
  /** The latest reading, or null before the first completes or when this machine has no Go key. */
  current: () => VendorQuotas | null;
  /** Starts polling if first; the returned function stops it if last. `onChange` fires per poll. */
  subscribe: (onChange: () => void) => () => void;
}

export function createOpencodeGoSource(options: {
  readKey: () => string | null;
  url: () => URL;
  pollMs: number;
  fetch?: typeof fetch;
  now?: () => number;
}): OpencodeGoSource {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let latest: VendorQuotas | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function poll(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    let reading: VendorQuotas | null;
    try {
      const key = options.readKey();
      reading = key ? await fetchGoQuotas({ fetch: doFetch, url: options.url(), key, now }) : null;
    } finally {
      inFlight = false;
    }
    // The last reader may have left while the request was out. Storing now would leave an old
    // reading for the next reader to see as current, so a poll that outlived its readers is dropped.
    if (!timer) return;
    latest = reading;
    if (listeners.size > 0) for (const listener of [...listeners]) listener();
  }

  return {
    current: () => latest,
    subscribe(onChange) {
      listeners.add(onChange);
      if (!timer) {
        // Armed before the first poll, which checks it to know a reader is still there.
        timer = setInterval(() => void poll(), options.pollMs);
        void poll();
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
          // A reading left to age would be shown as current to the next reader until their own
          // first poll lands; drop it so they see nothing rather than something old.
          latest = null;
        }
      };
    },
  };
}
