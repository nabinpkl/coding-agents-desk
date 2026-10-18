import { expect, it } from "vitest";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { pageLinks, resolveDestination } from "@/features/workspace-ide/editor/pdfLinks";

// A page 600 wide and 800 tall, whose PDF space has its origin at the bottom left, as PDF's does.
const viewport = {
  width: 600,
  height: 800,
  convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
};

function page(annotations: object[]): PDFPageProxy {
  return {
    getViewport: () => viewport,
    getAnnotations: async () => annotations,
  } as unknown as PDFPageProxy;
}

it("keeps the links a document may open, in percent of the page, and drops the rest", async () => {
  const links = await pageLinks(
    page([
      { id: "a", annotationType: 2, rect: [60, 700, 180, 720], url: "https://example.com/paper" },
      { id: "b", annotationType: 2, rect: [0, 0, 10, 10], url: "javascript:alert(1)" },
      { id: "c", annotationType: 2, rect: [0, 0, 10, 10], url: "file:///etc/passwd" },
      { id: "d", annotationType: 2, rect: [0, 400, 600, 420], dest: "chapter-2" },
      { id: "e", annotationType: 1, rect: [0, 0, 10, 10] },
      { id: "f", annotationType: 2, rect: [0, 0, 10, 10] },
    ]),
  );

  expect(links).toEqual([
    {
      key: "a",
      kind: "outside",
      href: "https://example.com/paper",
      box: { left: 10, top: 10, width: 20, height: 2.5 },
    },
    { key: "d", kind: "within", destination: "chapter-2", box: { left: 0, top: 47.5, width: 100, height: 2.5 } },
  ]);
});

it("finds the page and height a destination names, named or explicit", async () => {
  const reference = { num: 12, gen: 0 };
  const document = {
    numPages: 3,
    getDestination: async (name: string) => (name === "chapter-2" ? [reference, { name: "XYZ" }, 0, 600, null] : null),
    getPageIndex: async (ref: object) => (ref === reference ? 1 : -1),
    getPage: async () => ({ getViewport: () => viewport }),
  } as unknown as PDFDocumentProxy;

  expect(await resolveDestination(document, "chapter-2")).toEqual({ page: 2, fraction: 0.25 });
  expect(await resolveDestination(document, [2, { name: "Fit" }])).toEqual({ page: 3, fraction: 0 });
  expect(await resolveDestination(document, "missing")).toBeNull();
  expect(await resolveDestination(document, [9, { name: "Fit" }])).toBeNull();
});
