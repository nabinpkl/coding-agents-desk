// A PDF, drawn page by page with pdf.js.
//
// pdf.js rather than the browser's own viewer in an iframe, for two reasons. The phone is a live
// surface and its Chrome is WebKit, whose embedded PDF view is not the Mac's; drawing to canvas
// makes the two the same page. And nothing in the file runs: pdf.js parses it in a worker and
// paints pixels, so a PDF's own scripts never reach the one origin that can talk to the sidecar.
//
// Over each drawn page sit two layers: pdf.js's text layer, transparent words in the same places as
// the drawn ones so a reader can select and copy them, and the page's links (`pdfLinks.tsx`).
//
// pdf.js itself -- the document, each page's drawing, its words -- is started and stopped in
// `usePdfJs.ts`, and imported on the first PDF opened rather than with the panel.
//
// A page is drawn only while it is near the visible part of the scroller, and its bitmap is let go
// once it is far away. A page at a phone's pixel density is about 13MB of canvas, so a document
// that kept every page it had shown would grow without bound as it was read.

import { useCallback, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { DocumentNotice } from "@/features/workspace-ide/editor/documentPreview";
import { type PdfLink, PdfLinks, type PdfPlace, pageLinks } from "@/features/workspace-ide/editor/pdfLinks";
import {
  type Loaded,
  usePdfCanvas,
  usePdfDocument,
  usePdfTextLayer,
  useSettledWidth,
} from "@/features/workspace-ide/editor/usePdfJs";
import "@/features/workspace-ide/editor/pdfTextLayer.css";
import { useIntersecting } from "@/hooks/useIntersecting";
import { sourceKey, usePanelQuery } from "@/query/panelQuery";

/** How much of the scroller's height ahead of and behind the visible part has its pages drawn. */
const DRAW_AHEAD = "150% 0px";

/** Wider than this, a page reads worse rather than better, so a wide pane centres it. */
const MAX_PAGE_WIDTH = 960;

/** The scroller's padding and the gap between pages, which a jump to a page leaves above it. */
const PAGE_GAP = 12;

export function PdfPreview({
  name,
  url,
  revision,
}: {
  name: string;
  /** Where the bytes are fetched from; null where the transport has no address the page can load. */
  url: string | null;
  /** The bytes' hash: a new one draws the document again, the same one keeps what is on screen. */
  revision: string;
}) {
  const loaded: Loaded = usePdfDocument(url, revision);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const width = useSettledWidth(scroller);

  // A link to another place in the document scrolls this pane, not the page around it.
  const navigate = useCallback((place: PdfPlace) => {
    const target = scroller?.querySelector<HTMLElement>(`[data-pdf-page="${place.page}"]`);
    if (!scroller || !target) return;
    const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo({ top: top + place.fraction * target.offsetHeight - PAGE_GAP });
  }, [scroller]);

  if (url === null) {
    return <DocumentNotice title="PDF preview is not available" detail={`${name} has no address this panel can load it from.`} />;
  }
  if (loaded.status === "failed") {
    return <DocumentNotice title={`Could not open ${name}`} detail={loaded.reason} />;
  }
  if (loaded.status === "loading") return <DocumentNotice title={`Opening ${name}…`} />;

  const pages = Array.from({ length: loaded.document.numPages }, (_, at) => at + 1);
  return (
    <div ref={setScroller} className="h-full overflow-auto bg-muted/40 px-3 py-3">
      <div className="mx-auto grid gap-3" style={{ maxWidth: MAX_PAGE_WIDTH }}>
        {pages.map((number) => (
          <PdfPage
            key={number}
            document={loaded.document}
            number={number}
            count={pages.length}
            width={Math.min(width, MAX_PAGE_WIDTH)}
            scroller={scroller}
            fallbackRatio={loaded.ratio}
            onNavigate={navigate}
          />
        ))}
      </div>
    </div>
  );
}

function PdfPage({
  document,
  number,
  count,
  width,
  scroller,
  fallbackRatio,
  onNavigate,
}: {
  document: PDFDocumentProxy;
  number: number;
  count: number;
  /** The CSS width the page is drawn at, or 0 before the pane has been measured. */
  width: number;
  scroller: HTMLDivElement | null;
  /** The first page's shape, held until this page's own is known, so the scroll length is close. */
  fallbackRatio: number;
  onNavigate: (place: PdfPlace) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const near = useIntersecting(holder, scroller, DRAW_AHEAD);
  const { ratio, failure } = usePdfCanvas(canvas, document, number, width, near, fallbackRatio);
  usePdfTextLayer(text, holder, document, number, width, near);
  // Links are read once, the first time the page comes near: they are a few boxes, held in percent
  // of the page, so neither a new width nor scrolling away changes them.
  const linksQuery = usePanelQuery({
    queryKey: ["pdf-links", sourceKey(document), number],
    // A page whose links cannot be read is still a page: a line in the console, and no links.
    queryFn: () =>
      document.getPage(number).then(pageLinks).catch((cause: unknown) => {
        console.warn(`pdf: page ${number}'s links could not be read`, cause);
        return null;
      }),
    enabled: near,
    staleTime: Infinity,
  });
  const links: PdfLink[] | null = linksQuery.data ?? null;

  return (
    <div
      ref={holder}
      role="group"
      aria-label={`Page ${number} of ${count}`}
      data-pdf-page={number}
      className="pdf-page relative w-full overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-border"
      style={{ aspectRatio: `1 / ${ratio}` }}
    >
      <canvas ref={canvas} aria-hidden="true" className="block h-full w-full" />
      <div ref={text} className="textLayer" />
      {links ? <PdfLinks links={links} document={document} onNavigate={onNavigate} /> : null}
      {failure
        ? (
          <p className="absolute inset-0 m-0 grid place-items-center p-4 text-center text-sm text-neutral-600">
            Page {number} could not be drawn: {failure}
          </p>
        )
        : null}
    </div>
  );
}
