/**
 * How the page talks to more than one login session.
 *
 * A session is discovered, not declared: each sidecar announces itself on a shared board and the
 * dev server turns that board into `/session/index.json` and `/session/stream`. The page never sees
 * an origin or a token -- it addresses every session through the panel's own origin, which is the
 * only thing a phone can reach (127.0.0.1 on the phone is the phone, and the panel is TLS on the
 * tailnet, so a direct sidecar fetch is unreachable and mixed content besides).
 */

/** Ids become a path segment, so anything that could reshape the path is refused. */
const ID = /^[a-z0-9-]+$/i;

/**
 * Where a session's API answers.
 *
 * The default session keeps `/api`, because the host's relay and every existing caller already
 * speak it; naming one would have meant changing all of them for no gain.
 */
export function sessionApiPrefix(id?: string): string {
  return id ? `/session/${id}/api` : "/api";
}

/**
 * A session as the PAGE sees it: an id and a label, never an origin or a token.
 *
 * The page addresses every session through its own origin, so it has no use for either, and
 * withholding them means a compromised page still cannot reach a sidecar directly.
 */
export interface PanelSessionRef {
  readonly id?: string;
  readonly label: string;
}

/**
 * Reads `/session/index.json`. Entries without a usable label are dropped rather than rendered as
 * a nameless button, and anything that is not an array reads as "no index", which is also what an
 * origin that does not serve one looks like: one session, no picker.
 */
export function parseSessionIndex(value: unknown): PanelSessionRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const refs: PanelSessionRef[] = [];
  for (const entry of value) {
    const ref = entry as Partial<PanelSessionRef>;
    if (typeof ref?.label !== "string" || ref.label.length === 0) continue;
    if (ref.id !== undefined && (typeof ref.id !== "string" || !ID.test(ref.id))) continue;
    const key = ref.id ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref.id === undefined ? { label: ref.label } : { id: ref.id, label: ref.label });
  }
  return refs;
}
