/* Persistence contract the service depends on. Lookups return undefined and
 * mutations return false for a missing id; the service turns those into
 * NotFound. Only the store implementation touches the database. */
import type { Actor, Annotation, Coverage, NewAnnotation, Reply, Status } from "../../../shared/annotation.ts";

export interface ListFilter {
  /** Substring of the recorded page URL. */
  url?: string;
  status?: Status;
}

export interface StatusChange {
  status: Status;
  resolvedAt: string | null;
  resolvedBy: Actor | null;
  reopenedBy: Actor | null;
  updatedAt: string;
}

export interface Screenshot {
  mime: string;
  bytes: Uint8Array;
  coverage: Coverage;
  createdAt: string;
}

export interface AnnotationStore {
  insert(input: NewAnnotation, now: string): Annotation;
  get(id: number): Annotation | undefined;
  list(filter: ListFilter): Annotation[];
  setStatus(id: number, change: StatusChange): boolean;
  addReply(id: number, reply: Reply): boolean;
  remove(id: number): boolean;
  removeByUrl(url: string): number;
  putScreenshot(id: number, shot: Omit<Screenshot, "createdAt">, now: string): boolean;
  getScreenshot(id: number): Screenshot | undefined;
  /** Runs fn atomically; any throw rolls back every write made inside it. */
  transaction<T>(fn: () => T): T;
  close(): void;
}
