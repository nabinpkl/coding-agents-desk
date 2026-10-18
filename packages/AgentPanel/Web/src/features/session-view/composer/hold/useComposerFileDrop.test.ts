/**
 * One decision about where a file goes: the pane's drop for Claude, the held attachments for
 * opencode, nowhere for everything else.
 */

import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useComposerFileDrop } from "@/features/session-view/composer/hold/useComposerFileDrop";

function hook(overrides: Partial<Parameters<typeof useComposerFileDrop>[0]> = {}) {
  const onFileDrop = vi.fn();
  const result = renderHook(() =>
    useComposerFileDrop({
      isClaude: false,
      noPane: false,
      holdsForSend: false,
      dropToPane: () => {},
      holdForSend: () => {},
      engage: () => {},
      onFileDrop,
      ...overrides,
    }),
  );
  return { accept: result.result.current, onFileDrop };
}

describe("useComposerFileDrop", () => {
  it("hands Claude drops to the pane", () => {
    const dropToPane = vi.fn();
    const { accept, onFileDrop } = hook({ isClaude: true, dropToPane });
    accept?.([new File(["x"], "a.png", { type: "image/png" })]);
    expect(dropToPane).toHaveBeenCalledTimes(1);
    expect(onFileDrop).toHaveBeenCalledWith({ accept });
  });

  it("holds opencode picks for the send", () => {
    const holdForSend = vi.fn();
    const { accept } = hook({ holdsForSend: true, holdForSend });
    accept?.([new File(["x"], "a.png", { type: "image/png" })]);
    expect(holdForSend).toHaveBeenCalledTimes(1);
  });

  it("registers nothing where no transport takes a file", () => {
    const { accept, onFileDrop } = hook({ isClaude: true, noPane: true });
    expect(accept).toBeNull();
    expect(onFileDrop).toHaveBeenCalledWith(null);
  });
});
