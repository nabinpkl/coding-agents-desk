/**
 * The single seam between this web bundle and its native WKWebView host.
 *
 * The same bundle runs two ways: as a normal browser app (dev, and the future
 * pronunciation-practice web app) and embedded in AgentDesk's InteractionPanel
 * WKWebView on macOS/iOS. Only this module knows which — everything else calls
 * `isEmbedded()` or takes an injected transport, so no feature code reaches for
 * `window.webkit` directly.
 *
 * Native contract (mirrors AgentDesk's AgentPanel):
 *  - JS -> native: `window.webkit.messageHandlers.<handler>.postMessage(body)`,
 *    where `body` carries a short string tag under `t` plus payload fields.
 *  - native -> JS: native invokes `window.__<deliveryFn>(payload)`.
 *  - config:       native injects `window.__interactionConfig` at documentStart.
 */

/** Config the native host injects before the bundle boots. */
export interface HostConfig {
  voiceTransport?: "websocket" | "native";
  /**
   * The compact entry has two native owners. macOS inserts a completed
   * transcript immediately; the iPhone presents it for review before the
   * remote-keyboard path receives it.
   */
  dictationMode?: "macos" | "client";
  /** Loopback WebSocket URL of the host-owned voice sidecar, when present. */
  voiceWsUrl?: string;
  /**
   * Loopback HTTP origin of the host-owned voice sidecar for REST
   * (recordings, analysis), e.g. "http://127.0.0.1:7692". In a plain browser
   * the bundle falls back to the same-origin Next rewrite (`/api`); embedded,
   * there is no rewrite, so the host injects the sidecar origin directly.
   */
  apiBaseUrl?: string;
  /**
   * Capture settings the native host decides, because they depend on the
   * machine's audio route rather than anything this bundle can see. macOS
   * implements echo cancellation with a voice-processing unit that mutes the
   * speakers while it runs, so the host enables it only for its own built-in
   * microphone and revises the answer through a `voiceAudioConfig` delivery
   * when the default input device changes.
   */
  audio?: { echoCancellation?: boolean };
  /** Free-form feature flags the host may set. */
  flags?: Record<string, boolean>;
}

interface WebKitMessageHandler {
  postMessage(message: unknown): void;
}

interface WebKitBridge {
  messageHandlers?: Record<string, WebKitMessageHandler | undefined>;
}

declare global {
  interface Window {
    webkit?: WebKitBridge;
    __interactionConfig?: HostConfig;
  }
}

/** The macOS/iOS message-handler name both panels post through. */
export const INTERACTION_HANDLER = "interaction";

function hostWindow(): Window | undefined {
  return typeof window !== "undefined" ? window : undefined;
}

/** True when running inside the native InteractionPanel WKWebView. */
export function isEmbedded(handler: string = INTERACTION_HANDLER): boolean {
  return !!hostWindow()?.webkit?.messageHandlers?.[handler];
}

/** Config injected by the native host, or null in a plain browser. */
export function getHostConfig(): HostConfig | null {
  return hostWindow()?.__interactionConfig ?? null;
}

/**
 * Post one message to a native message handler. Throws when no such handler
 * exists (i.e. not embedded), so a miswired call fails loud instead of
 * silently dropping events.
 */
export function postToHost(
  handler: string,
  body: Record<string, unknown>,
): void {
  const messageHandler = hostWindow()?.webkit?.messageHandlers?.[handler];
  if (!messageHandler) {
    throw new Error(`postToHost: no native handler "${handler}" (not embedded)`);
  }
  messageHandler.postMessage(body);
}

/**
 * Install a native -> JS delivery callback under `window.__<deliveryFn>` and
 * return a disposer that removes it. Voice uses the concrete shared
 * `__interactionDeliver` dispatcher in interaction-delivery.ts; this generic helper
 * remains available to other InteractionPanel features.
 */
export function onHostMessage(
  deliveryFn: string,
  callback: (payload: unknown) => void,
): () => void {
  const w = hostWindow();
  if (!w) return () => {};
  const key = `__${deliveryFn}`;
  (w as unknown as Record<string, unknown>)[key] = callback;
  return () => {
    delete (w as unknown as Record<string, unknown>)[key];
  };
}
