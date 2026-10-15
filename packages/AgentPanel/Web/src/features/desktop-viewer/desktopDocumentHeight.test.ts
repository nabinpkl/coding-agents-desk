import { describe, expect, it } from "vitest";
import { desktopDocumentFallbackHeight } from "@/features/desktop-viewer/desktopDocumentHeight";

describe("desktopDocumentFallbackHeight", () => {
  it("recovers a zero-height WebKit viewport from the physical CSS screen", () => {
    expect(desktopDocumentFallbackHeight(0, 956)).toBe(956);
    expect(desktopDocumentFallbackHeight(844, 956)).toBeNull();
    expect(desktopDocumentFallbackHeight(0, 0)).toBeNull();
  });
});
