import { afterEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  confineLinks,
  DOCX_FRAME_SANDBOX,
  DocxPreview,
  inertElements,
  renderDocxFrame,
} from "@/features/workspace-ide/editor/DocxPreview";
import { documentLink } from "@/features/workspace-ide/editor/documentPreview";

// What is under test is what keeps a hostile document from running anything: which links survive,
// that elements are made where nothing runs, and what the frame is allowed. The rendering itself is
// docx-preview's and is checked in a browser against a real file.
const renderAsync = vi.hoisted(() => vi.fn());
vi.mock("docx-preview", () => ({ renderAsync }));

afterEach(() => {
  vi.unstubAllGlobals();
  renderAsync.mockReset();
});

it("keeps only links a document may open, and sends those to a new tab", () => {
  expect(documentLink("https://example.com/a")).toEqual({ kind: "outside", href: "https://example.com/a" });
  expect(documentLink("mailto:a@b.c")).toEqual({ kind: "outside", href: "mailto:a@b.c" });
  expect(documentLink("#_Toc1")).toEqual({ kind: "within", href: "#_Toc1" });
  expect(documentLink("javascript:alert(1)")).toBeNull();
  expect(documentLink(" JavaScript:alert(1)")).toBeNull();
  expect(documentLink("data:text/html,<script>1</script>")).toBeNull();
  expect(documentLink("file:///etc/passwd")).toBeNull();
  expect(documentLink("relative/page.html")).toBeNull();
  expect(documentLink("#")).toBeNull();

  const root = document.createElement("div");
  root.innerHTML =
    '<a href="javascript:alert(1)" target="_top">x</a><a href="https://example.com">y</a><a href="#here">z</a>';
  confineLinks(root);
  const [bad, outside, within] = [...root.querySelectorAll("a")];
  expect(bad!.hasAttribute("href")).toBe(false);
  expect(bad!.hasAttribute("target")).toBe(false);
  expect(outside!.getAttribute("target")).toBe("_blank");
  expect(outside!.getAttribute("rel")).toBe("noopener noreferrer");
  expect(within!.getAttribute("target")).toBe("_self");
});

it("makes every element in a document that has no window, as the library's own factory would", () => {
  const inert = document.implementation.createHTMLDocument("");
  const h = inertElements(inert);
  const made = h({
    tagName: "p",
    className: "docx",
    style: { color: "red" },
    id: "para",
    children: ["text", { ns: "http://www.w3.org/2000/svg", tagName: "svg" }],
  }) as HTMLElement;
  expect(made.ownerDocument).toBe(inert);
  expect(made.className).toBe("docx");
  expect(made.style.color).toBe("red");
  expect(made.id).toBe("para");
  expect(made.textContent).toBe("text");
  expect(made.lastElementChild?.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(inert.defaultView).toBeNull();
});

it("writes a frame whose styles cannot close themselves and whose links are confined", async () => {
  renderAsync.mockImplementation(async (_bytes, body: HTMLElement, styles: HTMLElement, options) => {
    const { h } = options as { h: (element: unknown) => Node };
    styles.appendChild(h({ tagName: "style", children: ["p{font-family:'x</style><meta http-equiv=refresh>'}"] }));
    body.appendChild(h({ tagName: "a", href: "javascript:alert(1)", children: ["bad"] }));
    body.appendChild(h({ tagName: "a", href: "https://example.com/", children: ["good"] }));
  });

  const html = await renderDocxFrame(await import("docx-preview"), new Uint8Array([1]));

  expect(renderAsync.mock.calls[0]![3]).toMatchObject({ renderAltChunks: false, useBase64URL: true });
  expect(html).toContain("x<\\/style><meta http-equiv=refresh>");
  expect(html.match(/<\/style>/g)).toHaveLength(2);
  expect(html).toContain("default-src 'none'");
  expect(html).not.toContain("javascript:");
  expect(html).toContain('<a href="https://example.com/" target="_blank" rel="noopener noreferrer">good</a>');
});

it("shows the document in a frame that may open tabs and nothing else", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([80, 75]))),
  );
  renderAsync.mockImplementation(async (_bytes, body: HTMLElement) => {
    body.textContent = "Quarterly report";
  });

  render(<DocxPreview name="report.docx" url="/api/bots/b/content?path=report.docx" revision="r1" />);

  const frame = await screen.findByTitle("report.docx");
  expect(frame.getAttribute("sandbox")).toBe(DOCX_FRAME_SANDBOX);
  expect(DOCX_FRAME_SANDBOX).not.toMatch(/allow-scripts|allow-same-origin/);
  expect(frame.getAttribute("srcdoc")).toContain("Quarterly report");
});

it("says what the sidecar refused", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "bot-file-unreadable", message: "File is too large to open here." },
          }),
          { status: 422 },
        ),
    ),
  );

  render(<DocxPreview name="huge.docx" url="/x" revision="r1" />);

  expect(await screen.findByText("Could not open huge.docx")).toBeInTheDocument();
  expect(screen.getByText("File is too large to open here.")).toBeInTheDocument();
});
