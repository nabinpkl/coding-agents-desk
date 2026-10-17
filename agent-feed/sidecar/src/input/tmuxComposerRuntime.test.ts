// Pushing into a pane: what is read first, what is written, and what a session with no
// pane is told. Plus the two commands that are pastes rather than typing -- a dropped
// image and a rename.

import { expect, test } from "bun:test";
import {
  CLOSE,
  END,
  KILL,
  OPEN,
  runtime,
  screenWith,
  typed,
} from "@/input/tmuxComposerHarness";
import {
  acceptTmuxComposerHint,
  composerPanes,
  dropTmuxComposerImage,
  readComposerAt,
  renameTmuxSession,
  submitTmuxComposer,
  syncTmuxComposer,
} from "@/input/tmuxComposer";
import { TmuxUnavailable } from "@/terminal/tmux/tmuxSessions";

test("reports tmux itself being gone as its own reason, rather than as an empty composer", async () => {
  const tmux = runtime({
    screen: async () => { throw new TmuxUnavailable("no server running"); },
  });
  expect(await readComposerAt("agentdesk-1", tmux))
    .toEqual({ text: null, hint: null, reason: "tmux-unavailable", exact: true, commands: [], pastes: [], images: [] });
});

test("marks a multi-row reading as wrapped, so the panel knows not to trust it exactly", async () => {
  const tmux = runtime({ screen: async () => screenWith(["alpha bravo", "charlie"]) });
  expect(await readComposerAt("agentdesk-1", tmux))
    .toEqual({ text: "alpha bravo charlie", hint: null, reason: null, exact: false, commands: [], pastes: [], images: [] });
});

test("re-reads the screen before every push, rather than trusting the caller's view of it", async () => {
  // A pane that answers with whatever it currently holds, and takes what is sent to it. A queue of
  // canned screens would not do here: a push reads the box, and then reads it again to watch the
  // send arrive, so what the second push sees has to be a consequence of the first.
  let held = "hel";
  const tmux = runtime({
    screen: async () => screenWith([held]),
    send: async (_pane, bytes) => {
      const keys = new TextDecoder().decode(bytes);
      tmux.sent.push(keys);
      held += typed(keys);
    },
  });
  await syncTmuxComposer("session", "hello", tmux);
  // The pane had "hel" at that instant, so only "lo" is typed -- even though the panel's own last
  // observation would have said otherwise.
  expect(tmux.sent).toEqual([`${END}${OPEN}lo${CLOSE}`]);
  await syncTmuxComposer("session", "hello", tmux);
  // Second time the pane already agrees, so nothing is sent at all.
  expect(tmux.sent).toHaveLength(1);
});

test("sends a clear and the text replacing it as two writes, not one", async () => {
  // Measured 2026-09-09 on a live pane: Ctrl+E, nine Ctrl+U and a 167-character paste in ONE
  // `send-keys` left the box holding the old text with the new appended and not one kill applied.
  // The same keys with a gap before the paste replaced the box. Claude applies an input chunk in
  // one pass, so a paste riding along with the kills is applied to the state they had not changed
  // yet -- and a big paste is what makes the chunk big enough to lose them.
  //
  // A pane that only empties once it has SEEN the kills, so a single write cannot pass this.
  let held = "alpha bravo charlie";
  const tmux = runtime({
    // Inexact, which is what routes this through the clear.
    screen: async () => screenWith([held], { row: 0, column: 0 }),
    send: async (_pane, bytes) => {
      const keys = new TextDecoder().decode(bytes);
      tmux.sent.push(keys);
      if (keys.includes(KILL)) held = "";
      else held += typed(keys);
    },
  });
  await syncTmuxComposer("session", "replaced entirely", tmux);
  expect(tmux.sent).toHaveLength(2);
  // The kills go alone, and carry no text with them.
  expect(tmux.sent[0]).not.toContain(OPEN);
  expect(tmux.sent[0]).toContain(KILL);
  // The text follows on its own, once the box has been seen to empty.
  expect(tmux.sent[1]).toBe(`${OPEN}replaced entirely${CLOSE}`);
  expect(held).toBe("replaced entirely");
});

test("keeps an ordinary append in one write, so typing does not pay for a screen read", async () => {
  // The other half of the split, and the reason it is conditional. Append is what every keystroke
  // a reader types goes through; gating it would put a `capture-pane` in front of each one.
  let held = "hel";
  const tmux = runtime({
    screen: async () => screenWith([held]),
    send: async (_pane, bytes) => {
      const keys = new TextDecoder().decode(bytes);
      tmux.sent.push(keys);
      held += typed(keys);
    },
  });
  await syncTmuxComposer("session", "hello", tmux);
  expect(tmux.sent).toEqual([`${END}${OPEN}lo${CLOSE}`]);
});

test("a push into a session with no pane sends nothing, and never reaches for a screen", async () => {
  let asked = false;
  const tmux = runtime({
    pane: async () => null,
    screen: async () => {
      asked = true;
      return screenWith([]);
    },
  });
  expect(await syncTmuxComposer("session", "hello", tmux))
    .toEqual({ text: null, hint: null, reason: "no-pane", exact: true, commands: [], pastes: [], images: [] });
  expect(tmux.sent).toEqual([]);
  expect(asked).toBe(false);
});

test("accepting the hint presses Tab, and guesses nothing about what lands", async () => {
  // Measured on a live pane: after a Tab the same row comes back with no faint run at all, which
  // is Claude turning its own suggestion into text. What the box then holds is the watcher's to
  // report, so `text` is null here rather than a copy of the hint.
  const tmux = runtime({
    screen: async () => { throw new Error("accepting must not read the screen"); },
  });
  expect(await acceptTmuxComposerHint("session", tmux))
    .toEqual({ text: null, hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] });
  expect(tmux.sent).toEqual(["\t"]);
});

test("submitting presses Return, and needs no screen to do it", async () => {
  const tmux = runtime({
    screen: async () => { throw new Error("submit must not read the screen"); },
  });
  expect(await submitTmuxComposer("session", tmux))
    .toEqual({ text: "", hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] });
  expect(tmux.sent).toEqual(["\r"]);
});

test("a dropped image is pasted as its path alone, which is what a terminal drop sends", async () => {
  // Measured in the CLI: the paste handler reads the text of THIS paste to decide whether it is
  // looking at a file path, so the path cannot ride along with anything else.
  const tmux = runtime({ screen: async () => screenWith([""]) });
  expect(await dropTmuxComposerImage("session", "/tmp/a-b/c.png", tmux))
    .toEqual({ text: null, hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] });
  expect(tmux.sent).toEqual([`${OPEN}/tmp/a-b/c.png${CLOSE}`]);
});

test("separates the path from text already in the box, with a space outside the paste", async () => {
  // Measured: a paste of " /tmp/x.png" splits on the space that precedes the slash and the empty
  // half is filtered away, so a space put INSIDE the paste never reaches the box.
  const tmux = runtime({ screen: async () => screenWith(["look at this"]) });
  await dropTmuxComposerImage("session", "/tmp/x.png", tmux);
  expect(tmux.sent).toEqual([` ${OPEN}/tmp/x.png${CLOSE}`]);
});

test("a drop into a session with no pane pastes nothing and says why", async () => {
  const tmux = runtime({ panes: composerPanes(), pane: async () => null });
  expect(await dropTmuxComposerImage("session", "/tmp/x.png", tmux))
    .toEqual({ text: null, hint: null, reason: "no-pane", exact: true, commands: [], pastes: [], images: [] });
  expect(tmux.sent).toEqual([]);
});

test("renames by pasting Claude's own command into an empty composer, with the Return", async () => {
  // One send, so nothing can be typed between the command and the Return into the box that was
  // just checked empty. Pasted rather than typed: measured that Claude dispatches a slash command
  // that arrives as a bracketed paste, which is also how it avoids the menu a typed `/` opens.
  const tmux = runtime({ screen: async () => screenWith([""]) });

  expect(await renameTmuxSession("s1", "What I called it", tmux)).toEqual({ renamed: true });
  expect(tmux.sent).toEqual([`${END}${OPEN}/rename What I called it${CLOSE}\r`]);
});

test("refuses to rename over text somebody is in the middle of writing", async () => {
  // The only way to type a command into a box is to type it where the reader was writing.
  const tmux = runtime({ screen: async () => screenWith(["half a thought"]) });

  expect(await renameTmuxSession("s1", "New name", tmux))
    .toEqual({ renamed: false, reason: "composer-busy" });
  expect(tmux.sent).toEqual([]);
});

test("refuses to rename a session with no pane to ask", async () => {
  // There is deliberately no fallback to writing the transcript: that moves the title and leaves
  // the address behind, which is the half rename this mechanism exists to avoid.
  const tmux = runtime({ pane: async () => null, screen: async () => screenWith([""]) });

  expect(await renameTmuxSession("s1", "New name", tmux))
    .toEqual({ renamed: false, reason: "no-pane" });
  expect(tmux.sent).toEqual([]);
});

test("reports tmux being gone as its own reason rather than as a busy composer", async () => {
  const tmux = runtime({
    screen: async () => { throw new TmuxUnavailable("no server running"); },
  });

  expect(await renameTmuxSession("s1", "New name", tmux))
    .toEqual({ renamed: false, reason: "tmux-unavailable" });
});

test("learns what the handle Claude answered with stands for, and types cheaply after", async () => {
  // The one moment this can be learned. Claude collapses a long paste as it takes it and never
  // says so -- the text goes into a table inside that process and the box gets a handle -- so the
  // side that did the pasting is the only side that ever holds both halves.
  const words = "zebra ".repeat(150);
  let rows = [""];
  const sent: string[] = [];
  const tmux = runtime({
    screen: async () => screenWith(rows),
    // A real pane collapses the paste. This one does the same thing to the same input, which is
    // what makes the test about the binding rather than about the threshold.
    send: async (_pane, bytes) => {
      const keys = new TextDecoder().decode(bytes);
      sent.push(keys);
      const text = typed(keys);
      rows = [text.length > 800 ? "[Pasted text #1]" : text];
    },
  });

  await syncTmuxComposer("session", words, tmux);
  expect(rows).toEqual(["[Pasted text #1]"]);
  expect(tmux.pastes.textFor("agentdesk-1", "[Pasted text #1]")).toBe(words);

  // And the next keystroke is now a keystroke. Without the binding this pushed the whole message
  // again, because a handle and the words it stands for share no prefix.
  const sentSoFar = sent.length;
  await syncTmuxComposer("session", `${words}!`, tmux);
  expect(sent.slice(sentSoFar)).toEqual([`${END}${OPEN}!${CLOSE}`]);
});

test("binds nothing when the box gained no handle, so a wrong guess is never pasted back", async () => {
  // Told apart by the handle being NEW rather than by the push having been long enough to
  // collapse. Claude's threshold is Claude's and could move; "the box gained a handle and we are
  // the ones who just pasted" stays true whatever the number is.
  const tmux = runtime({ screen: async () => screenWith(["short"]) });
  await syncTmuxComposer("session", "short and then some", tmux);
  expect(tmux.pastes.textFor("agentdesk-1", "[Pasted text #1]")).toBeNull();
});
