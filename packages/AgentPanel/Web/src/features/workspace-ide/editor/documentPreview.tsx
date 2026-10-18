// What the two binary-document previews share: fetching the file's bytes, the notice shown in
// place of a document, and which links inside a document may go anywhere.
//
// A PDF and a Word document are both read by the panel's own renderers from bytes it fetched
// itself, and both can carry links written by whoever made the file. Deciding what such a link
// may do in one place is what keeps the two from disagreeing about it.

import { parse } from "@/features/activity-feed/data-source/sidecarRoutes";

/**
 * The file's bytes, or the sidecar's refusal as an error. `parse` is what turns a route this
 * sidecar does not have yet into "restart it", which a peer that has not been shipped to needs.
 */
export async function fetchDocumentBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok) parse({ status: response.status, body: await response.text() });
  return new Uint8Array(await response.arrayBuffer());
}

/** Schemes a link inside a document may open. Anything else -- `javascript:` above all -- is inert. */
const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * What a link written inside a document may do: move within the document, open in a new tab, or
 * nothing. A relative link has nothing to be relative to here, so it is nothing as well.
 */
export type DocumentLink = { kind: "within"; href: string } | { kind: "outside"; href: string } | null;

export function documentLink(raw: string | null | undefined): DocumentLink {
  if (!raw) return null;
  if (raw.startsWith("#")) return raw.length > 1 ? { kind: "within", href: raw } : null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return OPENABLE_PROTOCOLS.has(url.protocol) ? { kind: "outside", href: url.href } : null;
}

/** The attributes an anchor that leaves the document carries: a new tab that cannot reach back. */
export const OUTSIDE_LINK = { target: "_blank", rel: "noopener noreferrer" } as const;

export function DocumentNotice({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">
      <div className="grid max-w-sm gap-1">
        <p className="m-0 text-foreground">{title}</p>
        {detail ? <p className="m-0 break-words">{detail}</p> : null}
      </div>
    </div>
  );
}

export function describeFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
