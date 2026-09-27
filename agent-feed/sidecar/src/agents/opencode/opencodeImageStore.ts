import type { OpencodeImagePayload } from "@/agents/opencode/opencodeEventMapper";

export interface StoredOpencodeImage {
  mediaType: string;
  data: string;
}

/**
 * How many decoded image bytes the pool keeps across its sessions.
 *
 * Generous, because these are screenshots at retina scale and a refused picture is a row that
 * names something the reader cannot see. A cap at all is because the bytes arrive inline on
 * every sync, and an unbounded map would grow with the session. Eviction is oldest-first, by
 * insertion order.
 */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/**
 * The pictures live opencode rows drew, waiting for the image route's on-demand reads.
 *
 * Split from the session pool because holding bytes is one idea and owning lifetimes is
 * another: the pool resolves addresses, this only keeps and forgets. Keyed by
 * `<session id>:<event id>:<ordinal>`, which the mapper numbers in block order at sync time.
 */
export class OpencodeImageStore {
  private readonly images = new Map<string, StoredOpencodeImage>();
  private bytes = 0;

  constructor(private readonly maxBytes: number = MAX_IMAGE_BYTES) {}

  /**
   * Keeps one batch's pictures, evicting oldest-first past the cap.
   *
   * Re-syncs re-store the same bytes under the same keys -- a refresh re-reads the tail, and
   * the tail still holds the same pictures -- so a steady session costs one Map churn per
   * refresh rather than growth. Base64 decodes at roughly 4/3, which is the size counted.
   */
  store(sessionId: string, images: OpencodeImagePayload[]): void {
    for (const image of images) {
      const key = `${sessionId}:${image.eventId}:${image.ordinal}`;
      const existing = this.images.get(key);
      if (existing) this.bytes -= Math.ceil((existing.data.length * 4) / 3);
      this.images.delete(key);
      this.images.set(key, { mediaType: image.mediaType, data: image.data });
      this.bytes += Math.ceil((image.data.length * 4) / 3);
    }
    while (this.bytes > this.maxBytes && this.images.size > 0) {
      const oldest = this.images.keys().next().value;
      if (oldest === undefined) break;
      const dropped = this.images.get(oldest);
      this.images.delete(oldest);
      if (dropped) this.bytes -= Math.ceil((dropped.data.length * 4) / 3);
    }
  }

  lookup(sessionId: string, eventId: string, ordinal: number): StoredOpencodeImage | null {
    return this.images.get(`${sessionId}:${eventId}:${ordinal}`) ?? null;
  }

  /** Drops a reaped session's pictures with it, rather than letting them age out of the cap. */
  dropSession(sessionId: string): void {
    for (const key of this.images.keys()) {
      if (!key.startsWith(`${sessionId}:`)) continue;
      const dropped = this.images.get(key);
      this.images.delete(key);
      if (dropped) this.bytes -= Math.ceil((dropped.data.length * 4) / 3);
    }
  }

  clear(): void {
    this.images.clear();
    this.bytes = 0;
  }
}
