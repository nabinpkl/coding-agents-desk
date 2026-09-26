/* Annotation use cases and their invariants. Adapters (HTTP, MCP) call only
 * this module. A missing id always throws NotFound; nothing returns a silent
 * null. */
import type { Actor, Annotation, CoverageItem, NewAnnotation } from "../../../shared/annotation.ts";
import { buildBrief } from "../../../shared/brief.ts";
import type { Recipient, SendInfo, SendOutcome, SendState } from "../../../shared/send.ts";
import { HubUnreachable, type HubClient } from "../hub.ts";
import type { AnnotationStore, ListFilter, Screenshot } from "../store/store.ts";

export class NotFound extends Error {
  constructor(what: string) {
    super(`not found: ${what}`);
    this.name = "NotFound";
  }
}

/** A valid request that the annotation's current state does not allow, e.g. reopening an open one. */
export class Conflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Conflict";
  }
}

/** A request the service refuses on its own rules (as opposed to schema validation at the edge). */
export class InvalidInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInput";
  }
}

export interface ElementsQuery {
  contains?: string;
  tag?: string;
  limit?: number;
}

export interface ElementsResult {
  total: number;
  returned: number;
  items: CoverageItem[];
}

const ELEMENTS_DEFAULT_LIMIT = 40;
const ELEMENTS_MAX_LIMIT = 200;

export type AnnotationService = ReturnType<typeof createAnnotationService>;

export function createAnnotationService(store: AnnotationStore, hub: HubClient, clock: () => string = () => new Date().toISOString()) {
  function mustGet(id: number): Annotation {
    const a = store.get(id);
    if (!a) throw new NotFound(`annotation ${id}`);
    return a;
  }

  function reply(id: number, by: Actor, text: string): Annotation {
    if (!store.addReply(id, { by, text, at: clock() })) throw new NotFound(`annotation ${id}`);
    return mustGet(id);
  }

  return {
    add(input: NewAnnotation): Annotation {
      return store.insert(input, clock());
    },

    list(filter: ListFilter): Annotation[] {
      return store.list(filter);
    },

    get: mustGet,

    resolve(id: number, by: Actor, message?: string): Annotation {
      return store.transaction(() => {
        const now = clock();
        if (!store.setStatus(id, { status: "resolved", resolvedAt: now, resolvedBy: by, reopenedBy: null, updatedAt: now })) {
          throw new NotFound(`annotation ${id}`);
        }
        return message ? reply(id, by, message) : mustGet(id);
      });
    },

    /** Only a resolved annotation can be reopened; a note on an open one is a reply. */
    reopen(id: number, by: Actor, message?: string): Annotation {
      return store.transaction(() => {
        if (mustGet(id).status !== "resolved") throw new Conflict(`annotation ${id} is already open; reply to add a note`);
        if (!store.setStatus(id, { status: "open", resolvedAt: null, resolvedBy: null, reopenedBy: by, updatedAt: clock() })) {
          throw new NotFound(`annotation ${id}`);
        }
        return message ? reply(id, by, message) : mustGet(id);
      });
    },

    reply,

    remove(id: number): void {
      if (!store.remove(id)) throw new NotFound(`annotation ${id}`);
    },

    clearByUrl(url: string): number {
      if (!url) throw new InvalidInput("url required");
      return store.removeByUrl(url);
    },

    attachScreenshot(id: number, shot: Omit<Screenshot, "createdAt">): Annotation {
      if (!store.putScreenshot(id, shot, clock())) throw new NotFound(`annotation ${id}`);
      return mustGet(id);
    },

    getScreenshot(id: number): Screenshot {
      mustGet(id);
      const shot = store.getScreenshot(id);
      if (!shot) throw new NotFound(`screenshot for annotation ${id}`);
      return shot;
    },

    elements(id: number, query: ElementsQuery): ElementsResult {
      mustGet(id);
      const all = store.getScreenshot(id)?.coverage.items ?? [];
      const tag = query.tag?.toUpperCase();
      const needle = query.contains?.toLowerCase();
      const matched = all.filter((n) => {
        if (tag && n.tag !== tag) return false;
        if (needle && !`${n.selector} ${n.tag} ${n.text}`.toLowerCase().includes(needle)) return false;
        return true;
      });
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? ELEMENTS_DEFAULT_LIMIT), 1), ELEMENTS_MAX_LIMIT);
      const items = matched.slice(0, limit);
      return { total: all.length, returned: items.length, items };
    },

    brief(url?: string): string {
      const open = store.list({ url, status: "open" });
      return buildBrief(open, { url: url || "all pages", title: "" });
    },

    // ----- Send: annotations to an agent session, over the hub -----

    /**
     * Everything the reader can send to, minus the owner.
     *
     * `human` is this surface, so offering it would let a reader message themselves. Bots stay in
     * the list because the panel groups sessions under them; whether a Bot is itself a choice is
     * the panel's call, and the hub is what refuses one.
     */
    async recipients(): Promise<Recipient[]> {
      const entries = await hub.directory();
      return entries.filter((entry) => entry.address !== "human");
    },

    /**
     * Hand annotations to a session as one hub request.
     *
     * The hub gets the brief and a ref per annotation, so the receiving agent can ask about any of
     * them by id through the tools it already has. The link back is written only after the hub has
     * the message: a recorded send that never left is a lie the panel would show as `queued`.
     */
    async send(ids: number[], to: string): Promise<SendOutcome> {
      const annotations = ids.map(mustGet);
      // The schema asks for at least one, but this is an invariant of the use case rather than of
      // one adapter, and an empty brief is not a thing to send.
      const [page] = annotations;
      if (!page) throw new InvalidInput("nothing to send");
      const { url, title } = page;
      // One brief names one page. Sending a brief that claims a URL the reader is not looking at
      // is worse than refusing, so the invariant is here rather than in a schema.
      if (annotations.some((a) => a.url !== url)) throw new InvalidInput("annotations from more than one page cannot be sent together");
      const directory = await hub.directory();
      const recipient = directory.find((entry) => entry.address === to);
      if (!recipient) throw new NotFound(`no such recipient: ${to}`);

      const message = await hub.send({
        to,
        body: buildBrief(annotations, { url, title }),
        refs: annotations.map((a) => ({ app: "agentdesk-annotator", kind: "annotation", id: String(a.id), url: a.url })),
      });
      const sentAt = clock();
      store.recordSend(ids, { messageId: message.id, to, toName: recipient.name, createdAt: sentAt });
      return { messageId: message.id, to, toName: recipient.name, state: message.state, sentAt, annotationIds: ids };
    },

    /**
     * Each annotation's newest send, with the state its message has reached.
     *
     * Annotations sent together share one message, so the states are fetched once per message
     * rather than once per annotation. A hub that cannot be reached is an error here, not a blank
     * state: "we do not know" and "delivered" must not look the same.
     */
    async sends(ids: number[]): Promise<SendInfo[]> {
      const records = store.latestSends(ids);
      const byMessage = new Map<string, Promise<SendState>>();
      for (const record of records) {
        if (byMessage.has(record.messageId)) continue;
        byMessage.set(record.messageId, hub.message(record.messageId).then((m) => m.state));
      }
      const states = new Map(await Promise.all([...byMessage].map(async ([id, pending]) => [id, await pending] as const)));
      return records.map((record) => {
        const state = states.get(record.messageId);
        if (state === undefined) throw new HubUnreachable(`hub returned no state for message ${record.messageId}`);
        return { ...record, state };
      });
    },
  };
}
