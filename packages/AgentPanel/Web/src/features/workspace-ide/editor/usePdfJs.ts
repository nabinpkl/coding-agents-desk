// pdf.js, kept in step with the PDF preview: a document loaded and destroyed with it, each page's
// canvas drawn and let go as it comes near and goes far, and the selectable words over it. Every
// one of these is a pdf.js object that keeps working until it is cancelled or destroyed, so each
// is started and stopped here, in effects named for it (ADR-0146 allows them in this file).
//
// The library is imported on the first PDF opened, not with the panel: it is the largest thing the
// panel loads, and most readers never open a PDF.

import { useEffect, useState, type RefObject } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { describeFailure, fetchDocumentBytes } from "@/features/workspace-ide/editor/documentPreview";

type PdfJs = typeof import("pdfjs-dist");

let library: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
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

/** How long the pane must hold one width before pages are drawn again at it. */
const RESIZE_SETTLE_MS = 150;

/** Past 2x, a page costs four times the memory for a sharpness nobody can see. */
const MAX_PIXEL_RATIO = 2;

export type Loaded =
  | { status: "loading" }
  | { status: "failed"; reason: string }
  | { status: "ready"; document: PDFDocumentProxy; ratio: number };

/**
 * The document at `url`, loaded while this is mounted and destroyed when it unmounts or a new
 * revision replaces it. Not a cached query: a pdf.js document holds a worker's memory until it is
 * destroyed, and a cache that kept it after the preview closed would hold that for nobody.
 */
export function usePdfDocument(url: string | null, revision: string): Loaded {
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded }>({ key: "", value: { status: "loading" } });
  const key = `${url}\n${revision}`;
  useEffect(() => {
    if (url === null) return;
    const abort = new AbortController();
    let task: PDFDocumentLoadingTask | null = null;
    let current = true;
    void (async () => {
      const [pdfjs, data] = await Promise.all([loadPdfJs(), fetchDocumentBytes(url, abort.signal)]);
      if (!current) return;
      task = pdfjs.getDocument({ data });
      const document = await task.promise;
      const first = (await document.getPage(1)).getViewport({ scale: 1 });
      if (current) setLoaded({ key, value: { status: "ready", document, ratio: first.height / first.width } });
    })().catch((cause: unknown) => {
      if (current) setLoaded({ key, value: { status: "failed", reason: describeFailure(cause) } });
    });
    return () => {
      current = false;
      abort.abort();
      void task?.destroy();
    };
  }, [url, key]);
  // A new revision shows "loading" from its first render, not the old document for one frame.
  return loaded.key === key ? loaded.value : { status: "loading" };
}

/**
 * One page drawn onto `canvas` at `width` while it is `near`, and let go when it is not: a page at
 * a phone's pixel density is about 13MB of canvas. Answers the page's own shape once known, and
 * what went wrong if the draw failed.
 */
export function usePdfCanvas(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  document: PDFDocumentProxy,
  number: number,
  width: number,
  near: boolean,
  fallbackRatio: number,
): { ratio: number; failure: string | null } {
  const [ratio, setRatio] = useState(fallbackRatio);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const target = canvasRef.current;
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
    void document
      .getPage(number)
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
  }, [canvasRef, document, number, width, near]);
  return { ratio, failure };
}

/**
 * The page's words, over the drawing, at the width it is drawn at. Let go with the bitmap, since a
 * page of text is thousands of spans.
 */
export function usePdfTextLayer(
  text: RefObject<HTMLDivElement | null>,
  holder: RefObject<HTMLDivElement | null>,
  document: PDFDocumentProxy,
  number: number,
  width: number,
  near: boolean,
): void {
  useEffect(() => {
    const container = text.current;
    if (!container) return;
    if (!near || width <= 0) {
      container.replaceChildren();
      return;
    }
    let current = true;
    let layer: TextLayer | null = null;
    void Promise.all([loadPdfJs(), document.getPage(number)])
      .then(([pdfjs, page]) => {
        if (!current) return;
        const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
        holder.current?.style.setProperty("--total-scale-factor", String(viewport.scale));
        container.replaceChildren();
        layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
        return layer.render();
      })
      .catch((cause: unknown) => {
        // The page is still drawn and readable; what is lost is selecting it, which is worth a line
        // in the console rather than covering the page with an error.
        if (current && !(cause instanceof Error && cause.name === "AbortException")) {
          console.warn(`pdf: page ${number} has no selectable text`, cause);
        }
      });
    return () => {
      current = false;
      layer?.cancel();
    };
  }, [text, holder, document, number, width, near]);
}

/**
 * The scroller's content width, updated once it has held still: a divider dragged across the pane
 * would otherwise redraw every page on every frame of the drag. The first measurement is taken at
 * once, so the document does not open blank for the settle time.
 */
export function useSettledWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    };
    // An observer reports once as soon as it starts watching, which is the first measurement, taken
    // at once; every report after it waits for the size to hold still.
    let first = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      if (first) {
        first = false;
        setWidth(measure());
        return;
      }
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
