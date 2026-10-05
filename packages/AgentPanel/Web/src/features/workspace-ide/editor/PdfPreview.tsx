// A PDF, drawn page by page with pdf.js.
//
// pdf.js rather than the browser's own viewer in an iframe, for two reasons. The phone is a live
// surface and its Chrome is WebKit, whose embedded PDF view is not the Mac's; drawing to canvas
// makes the two the same page. And nothing in the file runs: pdf.js parses it in a worker and
// paints pixels, so a PDF's own scripts never reach the one origin that can talk to the sidecar.
//
// The library is imported on the first PDF opened, not with the panel: it is the largest thing the
// panel loads, and most readers never open a PDF.
//
// A page is drawn only while it is near the visible part of the scroller, and its bitmap is let go
// once it is far away. A page at a phone's pixel density is about 13MB of canvas, so a document
// that kept every page it had shown would grow without bound as it was read.

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  describeFailure,
  DocumentNotice,
  fetchDocumentBytes,
} from "@/features/workspace-ide/editor/documentPreview";

type PdfJs = typeof import("pdfjs-dist");

let library: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  library ??= import("pdfjs-dist")
    .then((module) => {
      module.GlobalWorkerOptions.workerSrc = workerUrl;
      return module;
    })
    .catch((cause: unknown) => {
      // A failed import is not remembered: the next PDF opened tries again rather than inheriting
      // a rejection from a moment the dev server was restarting.
      library = null;
      throw cause;
    });
  return library;
}

/** How much of the scroller's height ahead of and behind the visible part has its pages drawn. */
const DRAW_AHEAD = "150% 0px";

/** Wider than this, a page reads worse rather than better, so a wide pane centres it. */
const MAX_PAGE_WIDTH = 960;

/** How long the pane must hold one width before pages are drawn again at it. */
const RESIZE_SETTLE_MS = 150;

/** Past 2x, a page costs four times the memory for a sharpness nobody can see. */
const MAX_PIXEL_RATIO = 2;

type Loaded =
  | { status: "loading" }
  | { status: "failed"; reason: string }
  | { status: "ready"; document: PDFDocumentProxy; ratio: number };

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
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const width = useSettledWidth(scroller);

  useEffect(() => {
    if (url === null) return;
    setLoaded({ status: "loading" });
    const abort = new AbortController();
    let task: PDFDocumentLoadingTask | null = null;
    let current = true;
    void (async () => {
      const [pdfjs, data] = await Promise.all([loadPdfJs(), fetchDocumentBytes(url, abort.signal)]);
      if (!current) return;
      task = pdfjs.getDocument({ data });
      const document = await task.promise;
      const first = (await document.getPage(1)).getViewport({ scale: 1 });
      if (current) setLoaded({ status: "ready", document, ratio: first.height / first.width });
    })().catch((cause: unknown) => {
      if (current) {
        setLoaded({ status: "failed", reason: describeFailure(cause) });
      }
    });
    return () => {
      current = false;
      abort.abort();
      void task?.destroy();
    };
  }, [url, revision]);

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
}: {
  document: PDFDocumentProxy;
  number: number;
  count: number;
  /** The CSS width the page is drawn at, or 0 before the pane has been measured. */
  width: number;
  scroller: HTMLDivElement | null;
  /** The first page's shape, held until this page's own is known, so the scroll length is close. */
  fallbackRatio: number;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [ratio, setRatio] = useState(fallbackRatio);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const element = holder.current;
    if (!element || !scroller) return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { root: scroller, rootMargin: DRAW_AHEAD },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroller]);

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    if (!near) {
      // Let the bitmap go: a zero-sized canvas holds no pixels.
      target.width = 0;
      target.height = 0;
      return;
    }
    if (width <= 0) return;
    let current = true;
    let task: RenderTask | null = null;
    void document.getPage(number)
      .then((page) => {
        if (!current) return;
        const shape = page.getViewport({ scale: 1 });
        setRatio(shape.height / shape.width);
        const density = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
        const viewport = page.getViewport({ scale: (width / shape.width) * density });
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        task = page.render({ canvas: target, viewport });
        return task.promise;
      })
      .then(() => {
        if (current) setFailure(null);
      })
      .catch((cause: unknown) => {
        // A cancelled draw is this effect being replaced, not a page that failed.
        if (!current || (cause instanceof Error && cause.name === "RenderingCancelledException")) return;
        setFailure(describeFailure(cause));
      });
    return () => {
      current = false;
      task?.cancel();
    };
  }, [document, number, width, near]);

  return (
    <div
      ref={holder}
      role="img"
      aria-label={`Page ${number} of ${count}`}
      className="relative w-full overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-border"
      style={{ aspectRatio: `1 / ${ratio}` }}
    >
      <canvas ref={canvas} className="block h-full w-full" />
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

/**
 * The scroller's content width, updated once it has held still: a divider dragged across the pane
 * would otherwise redraw every page on every frame of the drag. The first measurement is taken at
 * once, so the document does not open blank for the settle time.
 */
function useSettledWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    };
    setWidth(measure());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setWidth(measure()), RESIZE_SETTLE_MS);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [element]);
  return width;
}
