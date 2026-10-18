import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PdfPreview } from "@/features/workspace-ide/editor/PdfPreview";

// pdf.js parses in a worker and paints to canvas, neither of which jsdom has. What is under test is
// what this file decides: where the bytes come from, what a refusal says, and how many pages it lays
// out. The drawing itself is pdf.js's, and is checked in a browser.
const getDocument = vi.hoisted(() => vi.fn());
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument }));

function pdfDocument(pages: number) {
  const page = { getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }) };
  return { numPages: pages, getPage: vi.fn(async () => page) };
}

function answer(status: number, body: BodyInit) {
  return vi.fn(async () => new Response(body, { status }));
}

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  getDocument.mockReset();
});

it("lays out every page of the document fetched from the content address", async () => {
  const fetch = answer(200, new Uint8Array([37, 80, 68, 70]));
  vi.stubGlobal("fetch", fetch);
  getDocument.mockReturnValue({ promise: Promise.resolve(pdfDocument(3)), destroy: vi.fn() });

  render(<PdfPreview name="paper.pdf" url="/api/bots/b/content?path=paper.pdf" revision="r1" />);

  expect(await screen.findByRole("group", { name: "Page 3 of 3" })).toBeInTheDocument();
  expect(screen.getAllByRole("group")).toHaveLength(3);
  expect(fetch).toHaveBeenCalledWith("/api/bots/b/content?path=paper.pdf", expect.anything());
  expect(getDocument).toHaveBeenCalledWith({ data: new Uint8Array([37, 80, 68, 70]) });
});

it("says a sidecar without the content route needs restarting, rather than showing a blank page", async () => {
  vi.stubGlobal(
    "fetch",
    answer(
      404,
      JSON.stringify({
        error: { code: "route-not-found", message: "no route" },
      }),
    ),
  );

  render(<PdfPreview name="paper.pdf" url="/api/bots/b/content?path=paper.pdf" revision="r1" />);

  expect(await screen.findByText("Could not open paper.pdf")).toBeInTheDocument();
  expect(screen.getByText(/Restart it from the Profile menu/)).toBeInTheDocument();
  expect(getDocument).not.toHaveBeenCalled();
});

it("says what pdf.js could not parse", async () => {
  vi.stubGlobal("fetch", answer(200, new Uint8Array([1, 2, 3])));
  getDocument.mockReturnValue({ promise: Promise.reject(new Error("Invalid PDF structure.")), destroy: vi.fn() });

  render(<PdfPreview name="broken.pdf" url="/x" revision="r1" />);

  expect(await screen.findByText("Invalid PDF structure.")).toBeInTheDocument();
});

it("names the gap where the transport has no address to fetch from", () => {
  render(<PdfPreview name="paper.pdf" url={null} revision="r1" />);

  expect(screen.getByText("PDF preview is not available")).toBeInTheDocument();
});
