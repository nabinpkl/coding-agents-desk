// A Word document, rendered by docx-preview and shown inside a sandboxed frame.
//
// docx-preview turns the file into DOM, and parts of that DOM come straight from the file. Three
// of them would run someone else's code on the panel's origin, which is the one origin that can
// reach this machine's sidecar, so each is closed and then all of them are closed again at once:
//
// - An altChunk is HTML embedded in the document, which docx-preview renders by default into a
//   same-origin `<iframe srcdoc>` where its scripts run. `renderAltChunks` is off.
// - VML shapes copy their attributes from the file by name, so an `onload` in the file becomes a
//   handler on an element. Every element is created in an inert document instead -- one with no
//   browsing context, where nothing loads and no handler runs -- through docx-preview's own `h`.
// - A hyperlink's target is whatever the file says, `javascript:` included. `documentLink` keeps
//   only the schemes a document may open, and sends those to a new tab.
//
// And then the result is serialized into a frame sandboxed WITHOUT `allow-scripts` or
// `allow-same-origin`: no script runs in it and it cannot reach the panel, whatever a future
// version of the renderer gets wrong. The document's own CSS is confined to the frame too, which
// is also what keeps its page styles from leaking onto the panel.

import type { HElement } from "docx-preview";
import {
  describeFailure,
  documentLink,
  DocumentNotice,
  fetchDocumentBytes,
  OUTSIDE_LINK,
} from "@/features/workspace-ide/editor/documentPreview";
import { usePanelQuery } from "@/query/panelQuery";

type DocxPreviewLibrary = typeof import("docx-preview");

let library: Promise<DocxPreviewLibrary> | null = null;

function loadDocxPreview(): Promise<DocxPreviewLibrary> {
  library ??= import("docx-preview").catch((cause: unknown) => {
    // Not remembered, so the next document opened tries again rather than inheriting a rejection
    // from a moment the dev server was restarting.
    library = null;
    throw cause;
  });
  return library;
}

/**
 * What the frame may do. Popups so a link can open its new tab, and escaping the sandbox so that
 * tab is an ordinary page rather than one with scripts turned off. Never `allow-scripts`, never
 * `allow-same-origin`.
 */
export const DOCX_FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

type Rendered = { status: "loading" } | { status: "failed"; reason: string } | { status: "ready"; html: string };

export function DocxPreview({
  name,
  url,
  revision,
}: {
  name: string;
  /** Where the bytes are fetched from; null where the transport has no address the page can load. */
  url: string | null;
  /** The bytes' hash: a new one renders the document again. */
  revision: string;
}) {
  const query = usePanelQuery({
    queryKey: ["docx-preview", url, revision],
    queryFn: async ({ signal }) => {
      const [docx, bytes] = await Promise.all([loadDocxPreview(), fetchDocumentBytes(url!, signal)]);
      return renderDocxFrame(docx, bytes);
    },
    enabled: url !== null,
  });
  const rendered: Rendered = query.error
    ? { status: "failed", reason: describeFailure(query.error) }
    : query.data === undefined
      ? { status: "loading" }
      : { status: "ready", html: query.data };

  if (url === null) {
    return (
      <DocumentNotice
        title="Word preview is not available"
        detail={`${name} has no address this panel can load it from.`}
      />
    );
  }
  if (rendered.status === "failed") return <DocumentNotice title={`Could not open ${name}`} detail={rendered.reason} />;
  if (rendered.status === "loading") return <DocumentNotice title={`Opening ${name}…`} />;
  return (
    <div className="h-full bg-muted/40">
      <iframe
        title={name}
        sandbox={DOCX_FRAME_SANDBOX}
        srcDoc={rendered.html}
        className="block h-full w-full border-0"
        // The frame's document is light, and a frame whose scheme differs from its page's is
        // painted on an opaque canvas; agreeing lets the pane's own surface show around the pages.
        style={{ colorScheme: "light" }}
      />
    </div>
  );
}

/** Renders the document's bytes into the HTML of a frame, with nothing in it able to run. */
export async function renderDocxFrame(docx: DocxPreviewLibrary, bytes: Uint8Array): Promise<string> {
  const inert = document.implementation.createHTMLDocument("");
  const body = inert.createElement("div");
  const styles = inert.createElement("div");
  await docx.renderAsync(bytes, body, styles, {
    renderAltChunks: false,
    renderComments: false,
    // Images and fonts as data rather than blob URLs: a blob URL belongs to the panel's origin, and
    // the sandboxed frame has none, so it could not load them.
    useBase64URL: true,
    // Tab stops are measured against live layout, which an inert document does not have.
    experimental: false,
    h: inertElements(inert),
  });
  confineLinks(body);
  // Rebuilt rather than serialized: a style element's text is written out raw, so a font name
  // carrying `</style>` would end it and let markup through. `<\/` is the same text to CSS.
  const documentStyles = [...styles.querySelectorAll("style")]
    .map((style) => `<style>${(style.textContent ?? "").replaceAll("</", "<\\/")}</style>`)
    .join("");
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}">`,
    // A srcdoc frame resolves links against its PARENT's address, so `#bookmark` would load the
    // panel's own page into the frame. Against `about:srcdoc` it is a jump within this document.
    '<base href="about:srcdoc">',
    documentStyles,
    `<style>${FRAME_CSS}</style>`,
    "</head><body>",
    body.innerHTML,
    "</body></html>",
  ].join("");
}

/**
 * docx-preview's element factory, rebuilt to create in `inert` rather than in the page. The shape
 * is the library's own default: a string is text, a node is itself, and anything else is an
 * element whose remaining keys are assigned as properties.
 */
export function inertElements(inert: Document): (element: HElement | Node | string) => Node {
  const h = (element: HElement | Node | string): Node => {
    if (typeof element === "string") return inert.createTextNode(element);
    if (element instanceof Node) return element;
    const { ns, tagName, className, style, children, ...props } = element;
    if (tagName === "#fragment") {
      const fragment = inert.createDocumentFragment();
      children?.forEach((child) => fragment.appendChild(h(child)));
      return fragment;
    }
    if (tagName === "#comment") return inert.createComment(children ? String(children[0]) : "");
    const result = ns ? inert.createElementNS(ns, tagName) : inert.createElement(tagName);
    if (className) result.setAttribute("class", className);
    if (typeof style === "string") result.setAttribute("style", style);
    else if (style) Object.assign((result as HTMLElement).style, style);
    for (const [key, value] of Object.entries(props)) {
      if (value !== undefined) (result as unknown as Record<string, unknown>)[key] = value;
    }
    children?.forEach((child) => result.appendChild(h(child)));
    return result;
  };
  return h;
}

/** Every link either moves within the document, opens a new tab, or does nothing. */
export function confineLinks(root: ParentNode): void {
  for (const anchor of root.querySelectorAll("a")) {
    const link = documentLink(anchor.getAttribute("href"));
    if (link === null) {
      anchor.removeAttribute("href");
      anchor.removeAttribute("target");
    } else if (link.kind === "within") {
      anchor.setAttribute("target", "_self");
    } else {
      anchor.setAttribute("href", link.href);
      anchor.setAttribute("target", OUTSIDE_LINK.target);
      anchor.setAttribute("rel", OUTSIDE_LINK.rel);
    }
  }
}

/**
 * Nothing in the frame may fetch from anywhere: images and fonts arrive as data, so a stylesheet's
 * `url()` pointing off the machine -- which would tell its author the document was opened -- is
 * refused along with everything else.
 */
const FRAME_POLICY = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'";

/**
 * The frame's own layout, after the document's styles so it wins where they meet. Pages sit on the
 * pane's surface rather than docx-preview's grey, a page narrower than the pane is centred at its
 * own width, and a pane narrower than a page gets the page at the pane's width with its margins
 * cut down -- a phone otherwise scrolls sideways through an inch of white on each side.
 */
const FRAME_CSS = `
:root { color-scheme: light; }
html, body { margin: 0; background: transparent; }
.docx-wrapper { background: transparent; padding: 12px; gap: 12px; }
.docx-wrapper > section.docx {
  max-width: 100%;
  margin-bottom: 0;
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.08), 0 1px 3px rgb(0 0 0 / 0.12);
}
.docx img { max-width: 100%; height: auto; }
.docx a[href] { color: #0b57d0; text-decoration: underline; }
@media (max-width: 700px) {
  .docx-wrapper { padding: 8px; gap: 8px; }
  .docx-wrapper > section.docx { padding: 20px 16px !important; min-height: 0 !important; }
}
`;
