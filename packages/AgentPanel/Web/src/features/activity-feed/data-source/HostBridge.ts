/**
 * HostBridge seam between the BridgeDataSource and the native Swift container.
 *
 * The Swift host calls `window.__agentFeedDeliver(msg)` (injected via
 * evaluateJavaScript) to push messages into the webview. The
 * WebkitHostBridge registers a global handler for that entry point and
 * fans the message out to all registered callbacks.
 *
 * The native side (wired in a later task) calls:
 *   window.__agentFeedDeliver({ t: "agent-projects", ... })
 * or similar. The bridge posts outbound requests back to the host via
 *   window.webkit.messageHandlers.agentFeed.postMessage(msg)
 */

export interface HostBridge {
  /** Send a message to the Swift host. */
  postToHost(msg: unknown): void;
  /** Register a callback for messages arriving from the Swift host. Returns unsubscribe. */
  onHostMessage(cb: (msg: unknown) => void): () => void;
}

// ---------------------------------------------------------------------------
// WebkitHostBridge -- production implementation for WKWebView
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        agentFeed?: {
          postMessage(msg: unknown): void;
        };
      };
    };
    // Entry point the Swift side calls via evaluateJavaScript.
    __agentFeedDeliver?: (msg: unknown) => void;
  }
}

/** Registered callbacks across all WebkitHostBridge instances (there should
 *  be at most one instance, but the global list keeps the delivery function
 *  independent of any particular instance lifetime). */
const _webkitCallbacks = new Set<(msg: unknown) => void>();

/** Install the global delivery function exactly once. */
function _ensureWebkitGlobal(): void {
  if (window.__agentFeedDeliver !== undefined) return;
  window.__agentFeedDeliver = (msg: unknown) => {
    for (const cb of _webkitCallbacks) {
      try {
        cb(msg);
      } catch (err) {
        console.error("[HostBridge] callback threw", err);
      }
    }
  };
}

export class WebkitHostBridge implements HostBridge {
  postToHost(msg: unknown): void {
    window.webkit?.messageHandlers?.agentFeed?.postMessage(msg);
  }

  onHostMessage(cb: (msg: unknown) => void): () => void {
    _ensureWebkitGlobal();
    _webkitCallbacks.add(cb);
    return () => {
      _webkitCallbacks.delete(cb);
    };
  }
}

// ---------------------------------------------------------------------------
// FakeHostBridge -- test-only implementation
// ---------------------------------------------------------------------------

/**
 * Synchronous in-memory bridge for bun:test.
 * - Records every outbound message in `posted`.
 * - `deliver(msg)` synchronously fans the message to all registered callbacks.
 */
export class FakeHostBridge implements HostBridge {
  /** All messages posted to the host, in order. */
  readonly posted: unknown[] = [];

  private readonly _callbacks = new Set<(msg: unknown) => void>();

  postToHost(msg: unknown): void {
    this.posted.push(msg);
  }

  onHostMessage(cb: (msg: unknown) => void): () => void {
    this._callbacks.add(cb);
    return () => {
      this._callbacks.delete(cb);
    };
  }

  /** Synchronously deliver a message as if it came from the Swift host. */
  deliver(msg: unknown): void {
    for (const cb of this._callbacks) {
      cb(msg);
    }
  }
}
