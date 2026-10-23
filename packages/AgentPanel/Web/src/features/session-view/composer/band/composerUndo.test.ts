import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  EMPTY_HISTORY,
  recordEdit,
  redoEdit,
  undoEdit,
  undoKey,
  useComposerUndo,
  type UndoHistory,
} from "@/features/session-view/composer/band/composerUndo";

/** Types `text` one character at a time from `start`, with no pause. */
function typed(history: UndoHistory, start: string, text: string, at: number): UndoHistory {
  let value = start;
  for (const character of text) {
    history = recordEdit(history, value, value + character, at);
    value += character;
  }
  return history;
}

describe("the composer's own undo", () => {
  it("brings back a draft that something else emptied", () => {
    const history = typed(EMPTY_HISTORY, "", "a long draft", 0);
    // The mirror empties the field: nothing went through the history.
    const step = undoEdit(history, "");
    expect(step?.value).toBe("a long draft");
    // And redo goes back to the empty field.
    expect(redoEdit(step!.history, "a long draft")?.value).toBe("");
  });

  it("brings it back after typing has started again in the emptied field", () => {
    let history = typed(EMPTY_HISTORY, "", "a long draft", 0);
    history = typed(history, "", "x", 5_000);
    const first = undoEdit(history, "x");
    expect(first?.value).toBe("");
    expect(undoEdit(first!.history, "")?.value).toBe("a long draft");
  });

  it("undoes typing a step per pause, and a paste as a step of its own", () => {
    let history = typed(EMPTY_HISTORY, "", "one", 0);
    history = typed(history, "one", " two", 5_000);
    history = recordEdit(history, "one two", "one two PASTED", 5_100);
    const paste = undoEdit(history, "one two PASTED");
    expect(paste?.value).toBe("one two");
    const pause = undoEdit(paste!.history, "one two");
    expect(pause?.value).toBe("one");
    expect(undoEdit(pause!.history, "one")?.value).toBe("");
  });

  it("has nothing to undo before anything was typed, and redo is dropped by a new edit", () => {
    expect(undoEdit(EMPTY_HISTORY, "")).toBeNull();
    let history = typed(EMPTY_HISTORY, "", "ab", 0);
    history = undoEdit(history, "ab")!.history;
    history = recordEdit(history, "", "c", 9_000);
    expect(redoEdit(history, "c")).toBeNull();
  });

  it("reads Cmd+Z, Shift+Cmd+Z, Ctrl+Z and Ctrl+Y, and nothing else", () => {
    const key = (key: string, extra: Partial<Parameters<typeof undoKey>[0]> = {}) =>
      undoKey({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
    expect(key("z", { metaKey: true })).toBe("undo");
    expect(key("Z", { metaKey: true, shiftKey: true })).toBe("redo");
    expect(key("z", { ctrlKey: true })).toBe("undo");
    expect(key("y", { ctrlKey: true })).toBe("redo");
    expect(key("z")).toBeNull();
    expect(key("z", { metaKey: true, altKey: true })).toBeNull();
  });
});

describe("adding to the field twice before it renders", () => {
  it("builds the second on the first, and undoes them one at a time", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useComposerUndo("", onChange));
    act(() => {
      const undo = result.current;
      undo.change(`${undo.current()}first phrase`);
      undo.change(`${undo.current()} second phrase`);
      expect(onChange).toHaveBeenLastCalledWith("first phrase second phrase");
      const key = { key: "z", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {} };
      undo.onKeyDown(key as never);
      expect(onChange).toHaveBeenLastCalledWith("first phrase");
    });
  });
});
