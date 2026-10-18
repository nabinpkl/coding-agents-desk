// Whether the program in the pane wants SGR mouse reports, learned from its own output.
//
// Why the stream and not the descriptor: the descriptor snapshots tmux's `mouse_any_flag` and
// `mouse_sgr_flag` at open time, so a tile opened on a shell and later running `opencode` keeps
// a stale `false` while xterm is live on the alternate screen -- and the wheel handler's
// alternate-but-not-reporting arm does nothing at all. The `ESC[?1006h` that enables SGR flows
// through the pipe the moment the program starts, so watching it learns the mode the same way a
// real terminal does, for both backends and with no extra tmux calls.
//
// Why xterm ALSO needs telling: the wheel above is ours, but touch and clicks are xterm's own,
// driven by its internal mouse state -- and `terminal.reset()` on every checkpoint clears it
// while the history handed over carries no mode escapes. So a reopened tile scrolled with the
// wheel (our flag, intact) while a finger sent Up/Down arrows (xterm's flag, wiped). After each
// reset, and once on open, the viewer re-asserts what it tracked. Asserting is local-only: it
// sets xterm's state the way the program's own enable did and sends nothing to the program.
//
// The selectors are the program's own, not booleans, so the assert reproduces them exactly:
// 1000/1002/1003 select the tracking protocol (xterm ignores 1005/1015, so this does too),
// 1006/1016 select the SGR encoding. A report in the wrong encoding arrives as typed text, so
// forwarding still needs one of each -- the same both-flags rule `parsePaneDescription` keeps.

export interface TerminalMouseMode {
  /** Enabled tracking selector, or null. Seeded to 1002 when only the descriptor says so. */
  any: number | null;
  /** Enabled SGR selector, or null. */
  sgr: number | null;
  /** Unscanned tail of the previous chunk, so a sequence split across writes still matches. */
  tail: string;
}

/** Longest mode sequence this parses is under twenty chars; the tail keeps twice that. */
const TAIL_KEEP = 32;

const ANY_MOUSE_PARAMS = new Set([9, 1000, 1002, 1003]);
const SGR_MOUSE_PARAMS = new Set([1006, 1016]);

/** What a descriptor-only `true` re-asserts as: clicks plus wheel, with no hover spam. */
const DEFAULT_ANY_PARAM = 1002;
const DEFAULT_SGR_PARAM = 1006;

export function createTerminalMouseMode(reporting: boolean): TerminalMouseMode {
  return { any: reporting ? DEFAULT_ANY_PARAM : null, sgr: reporting ? DEFAULT_SGR_PARAM : null, tail: "" };
}

export function mouseModeReporting(mode: TerminalMouseMode): boolean {
  return mode.any !== null && mode.sgr !== null;
}

/**
 * Bytes the sidecar sent as text the mode parser can read.
 *
 * One byte per char: the sequences it looks for are ASCII, so a multi-byte run decodes to
 * unrelated chars that match nothing rather than to a false mode change.
 */
export function terminalBytesToText(bytes: Uint8Array): string {
  let text = "";
  const STEP = 8192;
  for (let index = 0; index < bytes.length; index += STEP) {
    text += String.fromCharCode(...bytes.subarray(index, index + STEP));
  }
  return text;
}

/**
 * The escapes that put xterm back in the tracked mode, or "" when it wants nothing.
 *
 * Written to the terminal, never sent: xterm applies them to its own state, which is exactly
 * what the program's original enable did on its way through.
 */
export function mouseModeAssert(mode: TerminalMouseMode): string {
  if (mode.any === null || mode.sgr === null) return "";
  return `\u001b[?${mode.any}h\u001b[?${mode.sgr}h`;
}

/**
 * Folds one chunk of terminal output into the mode. Mutates, because it rides the write path
 * on every output message and allocating per frame would tax a burst.
 */
export function updateTerminalMouseMode(mode: TerminalMouseMode, chunk: string): void {
  const text = mode.tail + chunk;
  // Private-mode set/reset only: `ESC[?params h` enables, `ESC[?params l` disables. A bare
  // `ESC[params h` without `?` is a different function (e.g. cursor motion) and is ignored.
  const pattern = /\u001b\[(\?[0-9;]*)?([hl])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const params = match[1];
    const terminal = match[2];
    if (!params || !params.startsWith("?")) continue;
    const enable = terminal === "h";
    for (const part of params.slice(1).split(";")) {
      if (part === "") continue;
      const value = Number.parseInt(part, 10);
      if (ANY_MOUSE_PARAMS.has(value)) mode.any = enable ? value : mode.any === value ? null : mode.any;
      else if (SGR_MOUSE_PARAMS.has(value)) mode.sgr = enable ? value : mode.sgr === value ? null : mode.sgr;
    }
  }
  // A full reset clears every private mode, mouse included. Checkpoint clears are our own
  // `terminal.reset()` beside the stream, not bytes in it, so this only answers a real `ESC c`
  // -- and the reset beside the stream gets its assert from the caller, not from here.
  if (text.includes("\u001bc")) {
    mode.any = null;
    mode.sgr = null;
  }
  mode.tail = text.slice(-TAIL_KEEP);
}
