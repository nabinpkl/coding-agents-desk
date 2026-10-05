// The links a PDF page carries, laid over the drawn page.
//
// pdf.js's own AnnotationLayer is not used: it draws every kind of annotation, form fields
// included, and wants the viewer's link service and stylesheet to do it. A link needs a box, an
// address and what to do when pressed, and that is all this draws.
//
// Where a link may go is the same rule a Word document's links follow (`documentLink`): another
// place in this document, or a new tab for http, https and mailto. pdf.js already refuses to hand
// over a URL that is not a valid absolute one; this is the second check, and it is the one that
// decides the scheme.

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { documentLink, OUTSIDE_LINK } from "@/features/workspace-ide/editor/documentPreview";

/** pdf.js's `AnnotationType.LINK`. */
const LINK_ANNOTATION = 2;

/** Where on its page a link sits, in percent of the page, so it holds at any drawn width. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type PdfLink =
  | { key: string; box: Box; kind: "outside"; href: string }
  | { key: string; box: Box; kind: "within"; destination: unknown };

/** A place in the document a link can take the reader: a page, and how far down it. */
export interface PdfPlace {
  /** 1-based, as pages are numbered on screen. */
  page: number;
  /** 0 at the top of the page, 1 at the bottom. */
  fraction: number;
}

interface LinkAnnotation {
  id?: string;
  annotationType?: number;
  rect?: number[];
  url?: string;
  dest?: unknown;
}

export async function pageLinks(page: PDFPageProxy): Promise<PdfLink[]> {
  const viewport = page.getViewport({ scale: 1 });
  const annotations = (await page.getAnnotations({ intent: "display" })) as LinkAnnotation[];
  return annotations.flatMap((annotation, at): PdfLink[] => {
    if (annotation.annotationType !== LINK_ANNOTATION || annotation.rect?.length !== 4) return [];
    const [left, bottom, right, top] = annotation.rect;
    const [x1, y1] = viewport.convertToViewportPoint(left!, bottom!) as number[];
    const [x2, y2] = viewport.convertToViewportPoint(right!, top!) as number[];
    const box = {
      left: (Math.min(x1!, x2!) / viewport.width) * 100,
      top: (Math.min(y1!, y2!) / viewport.height) * 100,
      width: (Math.abs(x2! - x1!) / viewport.width) * 100,
      height: (Math.abs(y2! - y1!) / viewport.height) * 100,
    };
    const key = annotation.id ?? String(at);
    if (annotation.url) {
      const link = documentLink(annotation.url);
      return link?.kind === "outside" ? [{ key, box, kind: "outside", href: link.href }] : [];
    }
    return annotation.dest ? [{ key, box, kind: "within", destination: annotation.dest }] : [];
  });
}

/**
 * The page and height a destination names. A named destination is looked up first; an explicit
 * one is `[pageRef, {name}, ...args]`, where the args that carry a top edge depend on the name.
 */
export async function resolveDestination(
  document: PDFDocumentProxy,
  destination: unknown,
): Promise<PdfPlace | null> {
  const explicit = typeof destination === "string" ? await document.getDestination(destination) : destination;
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  const [reference, kind, ...args] = explicit as [unknown, { name?: string } | undefined, ...unknown[]];
  const index = typeof reference === "number"
    ? reference
    : reference && typeof reference === "object"
      ? await document.getPageIndex(reference as { num: number; gen: number })
      : null;
  if (index === null || index < 0 || index >= document.numPages) return null;
  const top = kind?.name === "XYZ" ? args[1] : kind?.name === "FitH" || kind?.name === "FitBH" ? args[0] : kind?.name === "FitR" ? args[3] : null;
  if (typeof top !== "number") return { page: index + 1, fraction: 0 };
  const viewport = (await document.getPage(index + 1)).getViewport({ scale: 1 });
  const [, y] = viewport.convertToViewportPoint(0, top) as number[];
  return { page: index + 1, fraction: Math.min(1, Math.max(0, y! / viewport.height)) };
}

const LINK_CLASS = "pointer-events-auto absolute rounded-[2px] outline-none transition-colors"
  + " hover:bg-sky-500/15 focus-visible:ring-2 focus-visible:ring-primary";

export function PdfLinks({
  links,
  document,
  onNavigate,
}: {
  links: PdfLink[];
  document: PDFDocumentProxy;
  onNavigate: (place: PdfPlace) => void;
}) {
  if (links.length === 0) return null;
  return (
    // Above the text layer, so a link is pressed rather than its words selected -- the order pdf.js's
    // own viewer stacks them in.
    <div className="pointer-events-none absolute inset-0 z-10">
      {links.map((link) => {
        const style = {
          left: `${link.box.left}%`,
          top: `${link.box.top}%`,
          width: `${link.box.width}%`,
          height: `${link.box.height}%`,
        };
        return link.kind === "outside"
          ? (
            <a
              key={link.key}
              href={link.href}
              target={OUTSIDE_LINK.target}
              rel={OUTSIDE_LINK.rel}
              title={link.href}
              aria-label={`Open ${link.href}`}
              className={LINK_CLASS}
              style={style}
            />
          )
          : (
            <button
              key={link.key}
              type="button"
              aria-label="Go to the linked place in this document"
              className={LINK_CLASS}
              style={style}
              onClick={() => {
                void resolveDestination(document, link.destination).then((place) => {
                  if (place) onNavigate(place);
                });
              }}
            />
          );
      })}
    </div>
  );
}
