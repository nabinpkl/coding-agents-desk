import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composerPastes, meaning, pasteTokens } from "@/input/composer/composerPastes";

const look = (store: ReturnType<typeof composerPastes>, pane: string) => (token: string) => store.textFor(pane, token);

test("reads both spellings Claude writes, and neither of an image's", () => {
  // One line collapses with no count; more than one carries `+N lines`. Both are the same paste
  // as far as this is concerned, and an image token is a different thing entirely -- its token IS
  // the canonical text of what the box holds, so expanding it would be inventing content.
  expect(pasteTokens("a [Pasted text #1] b [Pasted text #12 +38 lines] c [Image #3]")).toEqual([
    { token: "[Pasted text #1]", id: 1 },
    { token: "[Pasted text #12 +38 lines]", id: 12 },
  ]);
});

test("expands only handles this side pasted, and leaves the rest exactly as they are", () => {
  const store = composerPastes();
  store.bind("pane-1", "[Pasted text #1]", "nine hundred characters");
  const read = look(store, "pane-1");
  expect(meaning("[Pasted text #1] tail", read)).toBe("nine hundred characters tail");
  // Somebody pasted this one at the keyboard. Retyping the characters of its name would detach
  // their paste in the pane and lose what they pasted, so it stays the handle it is.
  expect(meaning("[Pasted text #9 +4 lines] tail", read)).toBe("[Pasted text #9 +4 lines] tail");
});

test("keeps two panes' numbering apart, because the numbers belong to the CLI process", () => {
  const store = composerPastes();
  store.bind("pane-1", "[Pasted text #1]", "the first session's");
  store.bind("pane-2", "[Pasted text #1]", "the second session's");
  expect(store.textFor("pane-1", "[Pasted text #1]")).toBe("the first session's");
  expect(store.textFor("pane-2", "[Pasted text #1]")).toBe("the second session's");
  store.forget("pane-1");
  expect(store.textFor("pane-1", "[Pasted text #1]")).toBeNull();
  expect(store.textFor("pane-2", "[Pasted text #1]")).toBe("the second session's");
});

test("reports a held paste's shape without its content, which is what a reading carries", () => {
  const store = composerPastes();
  store.bind("pane-1", "[Pasted text #1]", "one\ntwo\nthree");
  expect(store.heldFor("pane-1", "[Pasted text #1]")).toEqual({ chars: 13, lines: 3 });
  expect(store.heldFor("pane-1", "[Pasted text #2]")).toBeNull();
});

test("drops the oldest binding rather than growing without bound", () => {
  // There is no event that says a handle is finished with -- a submitted turn takes its handles
  // with it and nothing says so -- so the budget is what ends a binding's life. Falling off it
  // costs exactly what not remembering cost before: a re-paste, and a preview that is not offered.
  const store = composerPastes();
  const big = "x".repeat(1024 * 1024);
  for (const id of [1, 2, 3, 4, 5]) store.bind("pane-1", `[Pasted text #${id}]`, big);
  expect(store.textFor("pane-1", "[Pasted text #1]")).toBeNull();
  expect(store.textFor("pane-1", "[Pasted text #5]")).toBe(big);
});

test("re-binding the same handle replaces it instead of counting it twice", () => {
  const store = composerPastes();
  store.bind("pane-1", "[Pasted text #1]", "first");
  store.bind("pane-1", "[Pasted text #1]", "second");
  expect(store.textFor("pane-1", "[Pasted text #1]")).toBe("second");
});

describe("kept across a restart", () => {
  const work = mkdtempSync(join(tmpdir(), "composer-handles-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  test("a new store over the same file knows what the old one bound", async () => {
    // The live sidecar restarts on every edit to its own tree, and a message being written then
    // used to lose its paste and its picture on the next correction.
    const file = join(work, "kept.json");
    const image = join(work, "a.png");
    writeFileSync(image, "png");
    const first = composerPastes(file);
    first.bind("1234:%7", "[Pasted text #1]", "nine hundred characters");
    first.bindImage("1234:%7", "[Image #2]", image);
    await Bun.sleep(400);

    expect(statSync(file).mode & 0o777).toBe(0o600);
    const second = composerPastes(file);
    expect(second.textFor("1234:%7", "[Pasted text #1]")).toBe("nine hundred characters");
    expect(second.heldFor("1234:%7", "[Pasted text #1]")).toEqual({ chars: 23, lines: 1 });
    expect(second.imageFor("1234:%7", "[Image #2]")).toBe(image);
  });

  test("forgets an image whose file has been swept, rather than dropping a dead path", () => {
    const store = composerPastes();
    store.bindImage("1234:%7", "[Image #1]", join(work, "gone.png"));
    expect(store.imageFor("1234:%7", "[Image #1]")).toBeNull();
  });

  test("starts empty from a file that is not a handles file, rather than failing to start", () => {
    const file = join(work, "broken.json");
    writeFileSync(file, "{not json");
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(composerPastes(file).textFor("1234:%7", "[Pasted text #1]")).toBeNull();
    } finally {
      console.error = quiet;
    }
  });
});
