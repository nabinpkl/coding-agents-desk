/* Annotation use cases and their invariants. Adapters (HTTP, MCP) call only
 * this module. A missing id always throws NotFound; nothing returns a silent
 * null. */
import type { Actor, Annotation, CoverageItem, NewAnnotation } from "../../../shared/annotation.ts";
import { buildBrief } from "../../../shared/brief.ts";
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

export function createAnnotationService(store: AnnotationStore, clock: () => string = () => new Date().toISOString()) {
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
  };
}
