// An image in the composer survives an edit that has to retype across it.
//
// Claude keeps a dropped image in a table inside its process and shows `[Image #N]` in the box.
// The box is mirrored from the panel, and an edit the mirror cannot make incrementally clears the
// box and pastes the whole message again. Pasting the token's NAME gives Claude the characters
// `[Image #1]` and no picture: measured on a live pane, a two-row message corrected by one
// backspace was submitted as a plain string with no image in it. So a retype drops the file again.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKSPACE, CLOSE, END, held, KILL, OPEN, runtime, screenWith } from "@/input/tmuxComposerHarness";
import {
  composerPastes,
  dropTmuxComposerImage,
  keystrokesFor,
  syncTmuxComposer,
} from "@/input/tmuxComposer";
import { insertedText } from "@/input/composer/composerKeystrokes";

// A real file: the store will not re-drop a path whose file has been swept.
const PNG = join(mkdtempSync(join(tmpdir(), "composer-redrop-")), "a.png");
writeFileSync(PNG, "png");
afterAll(() => rmSync(dirname(PNG), { recursive: true, force: true }));
const known = (token: string) => (token === "[Image #1]" || token === "[Image #2]" ? PNG : null);

test("a clear and retype drops a known image again instead of typing its name", () => {
  const box = held(["[Image #1] Leave that next we need to be able to", "click the relative path"]);
  const keys = keystrokesFor(box, "[Image #1] Leave that next we need to be able to click the relative pat", undefined, known);
  expect(keys.startsWith(END + KILL)).toBe(true);
  expect(keys).toContain(`${OPEN}${PNG}${CLOSE}`);
  expect(keys).toContain(`${OPEN} Leave that next`);
  expect(keys).not.toContain("[Image #1]");
});

test("an image renumbered by a re-drop is the same image, so nothing is sent", () => {
  // Diffed by number, `#2` in the box against `#1` in the draft would re-drop on every push.
  expect(keystrokesFor(held(["[Image #2] hi"]), "[Image #1] hi", undefined, known)).toBe("");
  expect(keystrokesFor(held(["[Image #2] hi"]), "[Image #1] hi there", undefined, known))
    .toBe(`${END}${OPEN} there${CLOSE}`);
});

test("a single-row correction that reaches past an image re-drops it", () => {
  // "b [Image #1] cd" rubbed out: one press for the token, one per character.
  const keys = keystrokesFor(held(["ab [Image #1] cd"]), "a [Image #1] cd", undefined, known);
  expect(keys.startsWith(END + BACKSPACE.repeat(6))).toBe(true);
  expect(keys).toContain(`${OPEN}${PNG}${CLOSE}`);
  expect(keys).not.toContain("[Image #1]");
});

test("an image this side never dropped is still left as the text the box holds", () => {
  expect(keystrokesFor(held(["alpha [Image #2] omega"]), "alpha omega"))
    .toBe(`${END}${BACKSPACE.repeat(7)}${OPEN}omega${CLOSE}`);
});

/**
 * A pane that behaves like Claude's box for the keys this module sends: a paste of an image path
 * becomes a fresh `[Image #N]`, Ctrl+U empties the box, a backspace takes a token whole, and the
 * text wraps at forty columns so a long message is several rows.
 */
function claudePane() {
  let text = "";
  let images = 0;
  const pastes = composerPastes();
  const sent: string[] = [];
  const apply = (keys: string): void => {
    let at = 0;
    while (at < keys.length) {
      if (keys.startsWith(OPEN, at)) {
        const end = keys.indexOf(CLOSE, at);
        const pasted = keys.slice(at + OPEN.length, end);
        text += pasted.endsWith(".png") ? `[Image #${++images}]` : pasted;
        at = end + CLOSE.length;
        continue;
      }
      const key = keys[at]!;
      if (key === KILL) text = "";
      else if (key === BACKSPACE) text = text.replace(/(\[Image #\d+\]|.)$/u, "");
      else if (key !== END) text += key;
      at += 1;
    }
  };
  const rows = (): string[] => {
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
      if (line.length > 0 && line.length + 1 + word.length > 40) {
        lines.push(line);
        line = word;
      } else {
        line = line.length > 0 ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
    return lines;
  };
  const tmux = runtime({
    screen: async () => screenWith(rows()),
    send: async (_pane, bytes) => {
      const keys = new TextDecoder().decode(bytes);
      sent.push(keys);
      apply(keys);
    },
    pastes,
  });
  return { tmux, sent, text: () => text };
}

test("dropped, typed after and corrected once: the box still holds a picture, not its name", async () => {
  const pane = claudePane();
  await dropTmuxComposerImage("session", PNG, pane.tmux);
  expect(pane.text()).toBe("[Image #1]");

  const message = "[Image #1] Leave that next we need to be able to click the relative path";
  await syncTmuxComposer("session", message, pane.tmux);
  expect(pane.text()).toBe(message);

  // One backspace on a two-row box is a clear and a retype, which is where the picture used to go.
  await syncTmuxComposer("session", message.slice(0, -1), pane.tmux);
  expect(pane.text()).toBe("[Image #2] Leave that next we need to be able to click the relative pat");
  expect(pane.sent.some((write) => write.includes(`${OPEN}[Image #1]`))).toBe(false);

  // And the renumbered image is the same one to the next push, which sends only what was typed.
  const writes = pane.sent.length;
  await syncTmuxComposer("session", `${message.slice(0, -1)}h!`, pane.tmux);
  expect(pane.sent.slice(writes)).toEqual([`${END}${OPEN}h!${CLOSE}`]);
});

test("a clear and retype pastes a known paste's words, not its handle", () => {
  // The same loss as the image, for a long paste: its handle typed back is a literal string.
  const words = "zebra ".repeat(150);
  const store = composerPastes();
  store.bind("pane-1", "[Pasted text #1]", words);
  const pasted = (token: string) => store.textFor("pane-1", token);
  const box = held(["[Pasted text #1] and then a sentence long enough that", "it wraps onto a second row"]);
  const keys = keystrokesFor(box, "[Pasted text #1] and then a sentence long enough that it wraps onto a second ro", pasted);
  expect(keys.startsWith(END + KILL)).toBe(true);
  expect(keys).toContain(`${OPEN}${words} and then a sentence`);
  expect(keys).not.toContain("[Pasted text #1]");
});

test("a paste nobody here made is still retyped as the handle the box shows", () => {
  const box = held(["[Pasted text #9] and then a sentence long enough that", "it wraps onto a second row"]);
  expect(keystrokesFor(box, "[Pasted text #9] short")).toContain(`${OPEN}[Pasted text #9] short${CLOSE}`);
});

test("the text after a re-dropped image is what a new paste handle stands for", () => {
  // Left unbound, the box's new `[Pasted text #4]` matched nothing in the draft, and every later
  // keystroke cleared the box and dropped the image again.
  const words = "zebra ".repeat(150);
  const store = composerPastes();
  store.bind("pane-1", "[Pasted text #2]", words);
  const keys = keystrokesFor(
    held(["[Image #1][Pasted text #2] and then a sentence long enough to", "wrap"]),
    "[Image #1][Pasted text #2] and then a sentence long enough to wra",
    (token) => store.textFor("pane-1", token),
    known,
  );
  expect(insertedText(keys)).toBe(`${words} and then a sentence long enough to wra`);
});
