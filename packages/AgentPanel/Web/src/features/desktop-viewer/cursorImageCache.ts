import type { WebrtcCursorImage } from "@agentdesk/agent-feed-wire";

export interface ResolvedCursorImage extends WebrtcCursorImage {
  source: string;
}

/** Browser counterpart of the native client's bounded hash-to-image store. */
export class CursorImageCache {
  private readonly images = new Map<string, string>();
  private readonly order: string[] = [];

  constructor(private readonly limit = 32) {}

  resolve(push: WebrtcCursorImage): ResolvedCursorImage | null {
    let source = this.images.get(push.hash);
    if (!source && push.png) {
      source = `data:image/png;base64,${push.png}`;
      this.images.set(push.hash, source);
      this.order.push(push.hash);
      if (this.order.length > this.limit) {
        const evicted = this.order.shift();
        if (evicted) this.images.delete(evicted);
      }
    }
    return source ? { ...push, source } : null;
  }
}
