import { useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type {
  AgentTerminalContext,
  AgentTerminalDescriptor,
  AgentTerminalStreamMessage,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "../activity-feed/data-source/SidecarDataSource";
import {
  cycleModifier,
  heldModifiers,
  RAIL_MODIFIERS_OFF,
  releaseArmed,
  type ModifierState,
} from "../keyboard/modifierLatch";
import { isTmuxAttach, terminalContextKey } from "./terminalContext";
import {
  FONT_SIZE_STEP,
  fittedFontSize,
  floorToStep,
  preferredScreenHeight,
  surfaceInset,
} from "./terminalTypeFit";
import {
  applyModifiers,
  bytesForRailKey,
  type RailKey,
  type RailModifier,
  type RailModifiers,
} from "@agentdesk/agent-feed-wire";

/**
 * A live terminal, and the chrome-facing handles for driving it from outside the grid.
 *
 * `modifiers` and `pressKey` exist for the key rail: a phone keyboard has no Ctrl, Esc, Tab or
 * arrows, so those keys are drawn beside the terminal and typed through here. They live on the
 * hook rather than in the rail because a held modifier has to reach `onData` -- the rail supplies
 * the Ctrl, the phone's own keyboard supplies the letter, and only this side sees both.
 */
export interface AgentTerminal {
  mountRef: RefObject<HTMLDivElement | null>;
  labels: TerminalLabels;
  /**
   * How tall this terminal's screen wants to be, or null until one is attached and measured.
   *
   * Only meaningful where the far end owns the grid: it is the height at which the type fills the
   * width the screen has, which is the height a pane free to choose its own should take. Capped by
   * whoever takes it -- this is what the screen wants, not what the surface can afford.
   */
  contentHeight: number | null;
  /** Whether this terminal is what the keyboard is typing into. */
  focused: boolean;
  modifiers: Record<RailModifier, ModifierState>;
  toggleModifier: (modifier: RailModifier) => void;
  pressKey: (key: RailKey) => void;
}

export type AgentTerminalState =
  | { kind: "ready"; descriptor: AgentTerminalDescriptor }
  | { kind: "error"; message: string }
  | { kind: "ended"; exitStatus?: number };

/**
 * How the terminal decides its own grid.
 *
 * `fit` measures the mount and follows it, which is what a single resizable pane wants. `fixed`
 * pins the grid, which is what a wall of them needs: a tile that re-fits would renegotiate the
 * PTY size on every layout change.
 *
 * A TMUX target ignores this entirely and renders at the pane's own geometry, whichever is asked
 * for. tmux has one window size per session, so a viewer that imposed its grid reflowed the
 * session in its owner's terminal; and a viewer that merely rendered at the wrong grid painted an
 * absolutely-addressed screen into the wrong rows, so text landed a row off from where the screen
 * said it was. Both were measured on a live Claude Code pane. A terminal that is entirely BLANK is
 * a different fault -- its event stream never opened -- and `openTerminalStream` says so now.
 */
export type TerminalSizing =
  | { kind: "fit" }
  | { kind: "fixed"; columns: number; rows: number };

/** What the terminal knows about itself that is worth showing next to it. */
export interface TerminalLabels {
  sync: string;
  ownership: string;
  source: string;
  view: string;
}

interface Dimensions {
  columns: number;
  rows: number;
}

/** A finger this far off where it landed was scrolling, not tapping. */
const TAP_SLOP_PX = 10;
/** How much scrollback to ask tmux for, and how much to keep. Matches the route's own ceiling. */
const HISTORY_LINES = 50_000;
/** Rows per wheel notch. Three is what a terminal emulator conventionally scrolls. */
const WHEEL_LINES = 3;

/**
 * The one import of xterm, shared by every terminal on the page.
 *
 * It stays dynamic so the library is not in the first bundle, but a wall of terminals firing the
 * import together is one question asked ten times. Holding the promise answers it once -- and it
 * also removes a real difference between them: two of those concurrent imports were observed being
 * served different module instances, one of which was not the test's mock.
 */
let xtermModule: Promise<typeof import("@xterm/xterm")> | null = null;

function loadXterm(): Promise<typeof import("@xterm/xterm")> {
  xtermModule ??= import("@xterm/xterm");
  return xtermModule;
}

/** The size the type is authored at, and what a fit scales away from. */
const BASE_FONT_SIZE = 13;
/** Above this a small grid in a large pane stops looking like a terminal. */
const MAXIMUM_FONT_SIZE = 28;
/**
 * Below this the screen is not worth rendering small enough to fit, so it overflows and scrolls.
 *
 * A tmux pane is 80 columns wide by convention, and a card's band on the canvas is a few hundred
 * pixels: fitting the whole width put the type at about nine pixels, which is smaller than any
 * label around it. This is a couple of points below the base size rather than the base itself,
 * because holding out for 13 would push a third of an 80-column screen off the side, where 11
 * costs a much shorter scroll for type that reads.
 *
 * The screen stays COMPLETE either way -- this is the size it stops shrinking at, not a crop. See
 * `fittedFontSize`'s own note on why overflow scrolls here rather than clipping.
 */
const MINIMUM_FONT_SIZE = 11;

/**
 * One xterm bound to one sidecar terminal: the stream, the input, the size negotiation, the theme.
 *
 * Extracted from the resizable pane when a grid of terminals needed the same protocol without the
 * same chrome. The alternative was a second copy of the checkpoint/output/viewport switch, which is
 * the part where a divergence would be invisible until a screen failed to paint.
 */
export function useAgentTerminal({ feed, context, sizing, paneShape = "adopt", onState }: {
  feed: SidecarDataSource;
  context: AgentTerminalContext;
  sizing: TerminalSizing;
  /**
   * What this surface does about the far end's shape, for a tmux pane it does not own.
   *
   * `adopt` asks the pane to become this box's shape, which is right for a surface somebody works
   * in. `follow` leaves the pane alone and scales the type until its screen fits instead -- for a
   * surface that is a glance at a session living somewhere else, where reshaping would reflow the
   * agent's whole screen to whatever size this box happens to be. See `AgentTerminalViewport.claim`.
   *
   * Ignored where there is no pane to reshape: an owned PTY is sized by whoever opened it.
   */
  paneShape?: "adopt" | "follow";
  /** Optional: a pane with nothing to learn from the state passes nothing. */
  onState?: (context: AgentTerminalContext, state: AgentTerminalState) => void;
}): AgentTerminal {
  const mountRef = useRef<HTMLDivElement>(null);
  const [syncLabel, setSyncLabel] = useState("Opening terminal");
  const [ownershipLabel, setOwnershipLabel] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [viewLabel, setViewLabel] = useState("");
  // How tall this terminal's screen wants to be, or null while nothing is attached or measurable.
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [modifiers, setModifiers] = useState<Record<RailModifier, ModifierState>>(RAIL_MODIFIERS_OFF);
  // The effect's `onData` reads the latch as it stands at the keystroke, not as it stood when the
  // terminal was created, and the effect deliberately does not re-run on a modifier press: that
  // would tear down the session to answer a Ctrl tap.
  const modifiersRef = useRef(modifiers);
  modifiersRef.current = modifiers;
  // Set once the terminal is open. Chrome outside the terminal -- the key rail -- types through it.
  const sendRef = useRef<((data: string) => void) | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    let teardown = (): void => {};
    const fail = (error: unknown): void => {
      if (disposed) return;
      onState?.(context, { kind: "error", message: String((error as Error).message ?? error) });
    };

    void loadXterm().then(({ Terminal }) => {
      if (disposed) return;
      const terminal = new Terminal({
        allowProposedApi: false,
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: BASE_FONT_SIZE,
        lineHeight: 1.08,
        // Deep enough to hold what tmux hands over on open plus a long run of live output. The
        // point of the terminals wall is reading back over a session, and a shallow buffer is the
        // one thing that cannot be fixed later by scrolling.
        scrollback: HISTORY_LINES,
        // Wheel scrolling animates instead of jumping a row at a time, which is what makes reading
        // back over output feel like scrolling a page rather than stepping through it.
        smoothScrollDuration: 120,
        theme: terminalTheme(),
      });
      // Deliberately the DOM renderer, and this is the second time round.
      //
      // `@xterm/addon-webgl` was added for the speed and removed the same day: on a device with a
      // devicePixelRatio of 2 -- every Retina Mac and every phone -- it draws each glyph at twice
      // its cell, so a 41-column pane rendered about 20 columns and clipped the rest. Measured
      // both ways in a real browser at both ratios; the DOM renderer is correct at both. The
      // version pairing was not the problem: `0.20.0-beta.291` is the peer match for the vendored
      // `6.1.0-beta.292` core, and it was the one installed.
      terminal.open(mount);

      // The wheel belongs to whoever is reading, not to the program being read.
      //
      // On the normal screen the bytes are in this buffer, so scrolling it is the whole job, and
      // returning false keeps xterm from forwarding a mouse event that tmux would answer by
      // entering copy-mode. On the alternate screen there is no scrollback by definition -- a
      // fullscreen program redraws rather than scrolls -- and xterm's fallback there is to send
      // arrow keys, which in an agent's composer edits the line instead of moving a view. So the
      // wheel does nothing there, which is at least honest.
      terminal.attachCustomWheelEventHandler((event) => {
        if (terminal.buffer.active.type === "alternate") return false;
        terminal.scrollLines(Math.sign(event.deltaY) * WHEEL_LINES);
        return false;
      });

      // A tap has to focus the terminal by hand, or a phone gets no keyboard.
      //
      // xterm focuses from `mousedown` (`bindMouse`'s requestFocus). On a touch device it also
      // installs a Gesture on the screen element, and that Gesture calls `preventDefault()` on
      // touchstart and touchend -- which is exactly what suppresses the browser's synthesized
      // mouse events. So the mousedown that would have focused never arrives, nothing focuses the
      // hidden textarea, and iOS has no focused field to raise a keyboard for. Measured against
      // the vendored source rather than inferred from the symptom.
      //
      // Focused from the touch itself, for two reasons: it is on the mount, which bubbles before
      // the document-level listener that stops propagation, and it runs synchronously inside the
      // gesture, which is the condition iOS puts on showing the keyboard at all.
      let touchOrigin: { x: number; y: number } | null = null;
      const noteTouchStart = (event: TouchEvent): void => {
        const touch = event.touches.length === 1 ? event.touches[0] : null;
        touchOrigin = touch ? { x: touch.clientX, y: touch.clientY } : null;
      };
      // Only a tap, never a drag: a finger scrolling back over output has not asked to type, and
      // a keyboard thrown up mid-scroll takes half the screen the reader was using.
      const focusOnTap = (event: TouchEvent): void => {
        const origin = touchOrigin;
        touchOrigin = null;
        const touch = event.changedTouches[0];
        if (!origin || !touch) return;
        const moved = Math.abs(touch.clientX - origin.x) > TAP_SLOP_PX
          || Math.abs(touch.clientY - origin.y) > TAP_SLOP_PX;
        if (moved) return;
        terminal.focus();
      };
      mount.addEventListener("touchstart", noteTouchStart, { passive: true });
      mount.addEventListener("touchend", focusOnTap);

      // Whether this terminal is the thing being typed into. The key rail is chrome for typing, so
      // it appears with the keyboard and leaves with it rather than standing there permanently.
      const textarea = terminal.textarea;
      const noteFocus = (): void => setFocused(true);
      const noteBlur = (): void => {
        setFocused(false);
        // A latch is held for the next key of THIS terminal. Leaving one armed across a blur means
        // it fires into whatever the user typed next somewhere else entirely.
        setModifiers(RAIL_MODIFIERS_OFF);
      };
      textarea?.addEventListener("focus", noteFocus);
      textarea?.addEventListener("blur", noteBlur);
      if (textarea && document.activeElement === textarea) setFocused(true);

      let descriptor: AgentTerminalDescriptor | null = null;
      let unsubscribe: (() => void) | null = null;
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      // The cell at the BASE type size, measured once by `fitType`. Kept up here because two
      // readers need it: the fit itself, and the viewport report, which must describe the box in
      // grid cells the far end can act on rather than in whatever the fit has shrunk them to.
      let baseCell: { width: number; height: number } | null = null;
      // Whether the far end took the shape this viewer asked for, straight from its own report.
      // What it decides is which of TWO ways of making a screen fit a box is in force, and only
      // ever one of them: see `fitType`.
      let ownsPaneShape = false;
      let viewportSequence = 0;
      let remoteClosed = false;
      let writes = Promise.resolve();

      const enqueueWrite = (operation: () => void | Promise<void>): void => {
        writes = writes.then(operation).catch(fail);
      };
      const write = (encoded: string): void => {
        enqueueWrite(() => new Promise<void>((resolve) => terminal.write(bytesFromBase64(encoded), resolve)));
      };
      const publishViewport = (): void => {
        if (!descriptor || disposed || remoteClosed) return;
        // What this viewer's BOX would hold, which is what the far end resizes to. Measured at
        // the base type rather than the fitted one: the fit shrinks the type to squeeze an
        // oversized grid in, so reporting the fitted cell would describe the grid already in force
        // and ask the pane to stay exactly as it is. `baseCell` is null only before the first fit,
        // when nothing has been scaled and the current cell IS the base one.
        const dimensions = sizing.kind === "fixed"
          ? { columns: sizing.columns, rows: sizing.rows }
          : proposedDimensions(terminal, mount, paneAuthoritative ? baseCell : null);
        if (!dimensions) return;
        viewportSequence += 1;
        setViewLabel(`View ${dimensions.columns}×${dimensions.rows}`);
        void feed.updateTerminalViewport(descriptor.terminalId, {
          sequence: String(viewportSequence),
          active: true,
          // A property of the SURFACE, not of the occasion. It used to be false on a resize and
          // true on a checkpoint, which described nothing: the sidecar read neither and reshaped
          // the pane every time.
          claim: adoptsPaneShape,
          ...dimensions,
        }).catch(fail);
      };
      const scheduleViewport = (): void => {
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => publishViewport(), 120);
      };
      const finishRemote = (state: AgentTerminalState): void => {
        remoteClosed = true;
        unsubscribe?.();
        unsubscribe = null;
        onState?.(context, state);
      };
      // A resumed CLI is worth keeping alive for the next visit, so its viewer leaving is a
      // detach. An attach is not: the PTY session outliving its viewer means the tmux client stays
      // connected, and a client that nobody is watching still holds the window at the tile's size
      // in whatever terminal the user has that session open in. Killing ends the attach; the tmux
      // session it was attached to is untouched.
      const closeMode = isTmuxAttach(context) ? "kill" : "detach";
      // Whether the far end owns the grid. True for tmux, where the pane is the size of record.
      const paneAuthoritative = isTmuxAttach(context);
      // Whether this surface asks the pane to take its shape. Only a tmux pane has a shape to ask
      // about; an owned PTY is sized by whoever opened it and never reads this.
      const adoptsPaneShape = !paneAuthoritative || paneShape === "adopt";
      const release = (terminalId: string): void => {
        void feed.closeTerminal(terminalId, closeMode).catch((error) => {
          console.error(`Agent terminal ${closeMode} failed`, error);
        });
      };
      const receive = (message: AgentTerminalStreamMessage): void => {
        switch (message.type) {
          case "checkpointBegin":
            setSyncLabel("Synchronizing");
            setSourceLabel(`Source ${message.columns}×${message.rows}`);
            enqueueWrite(() => {
              terminal.clear();
              terminal.reset();
              terminal.resize(message.columns, message.rows);
              // A new grid is a new shape to fit the type to, and a new height for the pane to
              // want. Nothing else reports this: the mount has not moved.
              fitType();
            });
            break;
          case "checkpointChunk":
          case "output":
            write(message.data);
            break;
          case "checkpointEnd":
            enqueueWrite(() => {
              setSyncLabel(`Revision ${message.revision}`);
              scheduleViewport();
            });
            break;
          case "viewport": {
            // A follower never reports controlling the layout, even where the shapes happen to
            // agree: it did not ask for this one and will not keep it if the pane moves. Braced
            // because a declaration in a bare `case` shares the whole switch's scope.
            const controls = message.isOwner && adoptsPaneShape;
            setOwnershipLabel(
              // Three different things, and a follower is not the third: "frozen" is a pane that
              // would not take a shape it was ASKED for, which is a fault worth reading, where
              // this one is a surface that deliberately never asks.
              controls
                ? "Controls layout"
                : !adoptsPaneShape
                  ? "Follows the pane"
                  : message.ownerClientId !== "0"
                    ? `Following ${message.ownerTitle || "viewer"}`
                    : "Source frozen",
            );
            setSourceLabel(`Source ${message.sourceColumns}×${message.sourceRows}`);
            setViewLabel(`View ${message.viewColumns}×${message.viewRows}`);
            // Which of the two fits is in force, and it can change under a viewer: a pane stops
            // being ours the moment somebody attaches a terminal to it, and starts being ours
            // again when they leave. Re-fit on the change so the type moves with it rather than
            // staying at whatever the other regime left behind.
            if (paneAuthoritative && controls !== ownsPaneShape) {
              ownsPaneShape = controls;
              enqueueWrite(() => fitType());
            }
            break;
          }
          case "exited":
            finishRemote({ kind: "ended", exitStatus: message.status });
            break;
          case "detached":
            finishRemote({ kind: "ended" });
            break;
          case "error":
            remoteClosed = true;
            unsubscribe?.();
            unsubscribe = null;
            fail(new Error(message.message));
            break;
        }
      };

      const send = (data: string): void => {
        if (!descriptor || remoteClosed) return;
        void feed.sendTerminalInput(descriptor.terminalId, data).catch(fail);
      };
      sendRef.current = send;
      const input = terminal.onData((data) => {
        // The rail's modifiers are held over whatever the phone's own keyboard produced, which is
        // the only way a keyboard with no Ctrl on it can send one.
        const held = heldModifiers(modifiersRef.current);
        send(applyModifiers(data, held));
        if (held.ctrl || held.alt || held.shift) setModifiers(releaseArmed);
      });
      const binaryInput = terminal.onBinary((data) => {
        if (!descriptor || remoteClosed) return;
        void feed.sendTerminalInput(descriptor.terminalId, base64FromBinaryString(data), "base64")
          .catch(fail);
      });
      /**
       * Scales the TYPE, for a grid this side does not own.
       *
       * A tmux pane is whatever shape its own terminal made it -- 41 columns by 20 rows, measured
       * -- and the band showing it is nothing like that shape. At a fixed type size the screen
       * therefore either ran off the bottom of the band and had to be scrolled, or sat in the
       * corner of a box several times its size. Neither is fixable by resizing the pane: tmux has
       * one window size for everyone and setting it from here reflows the session in whatever
       * terminal its owner has it open in, which is why `tmuxAttachment` refuses to.
       *
       * So the grid keeps its shape and the type grows or shrinks until the whole screen fits the
       * space. Measured ONCE, at the base size: cell metrics are proportional to the font, so
       * everything after that is arithmetic. Re-measuring after each change instead reads a layout
       * xterm has not finished writing, and iterating on that oscillates.
       */
      const fitType = (): void => {
        const cell = terminal.dimensions?.css.cell;
        if (!cell || cell.width <= 0 || cell.height <= 0) return;
        const grid = { columns: terminal.cols, rows: terminal.rows };
        if (!(grid.columns > 0) || !(grid.rows > 0)) return;
        if (!baseCell) {
          if (terminal.options.fontSize !== BASE_FONT_SIZE) return;
          baseCell = { width: cell.width, height: cell.height };
        }
        // A grid this viewer ASKED for already fits the box at base type, because that is exactly
        // what it was computed from. Scaling it as well puts two controllers on one box, and they
        // do not agree: the fit stretches the type to fill the width, that changes the rendered
        // height and whether a scrollbar is there, the next report measures a different box and
        // asks for a different grid. Measured on two live cards that nobody was touching -- both
        // cycled 40 -> 45 -> 50 -> 40 columns twice a second for as long as they were open.
        //
        // So exactly one of the two runs. Ours: the type stays at base and the grid follows the
        // box. Not ours: the grid is fixed and the type follows it, which is everything below.
        if (ownsPaneShape) {
          if (terminal.options.fontSize !== BASE_FONT_SIZE) terminal.options.fontSize = BASE_FONT_SIZE;
          // The band sizes itself from this, and a height asked for on behalf of a grid that is
          // already the right shape is the loop's other half.
          setContentHeight(null);
          return;
        }
        // Both boxes: the mount is the space the band gives, and the terminal element carries the
        // padding that makes the screen read as a screen rather than as a block of text. Missing
        // the second one sizes the grid to the whole space and then adds the padding to it, which
        // is an overflow and a scrollbar for the sake of eight pixels.
        const padding = paddingOf(mount);
        // Measured with any inset from a previous pass taken back off, because the inset is
        // derived from the space and would otherwise eat it a little more on every reflow.
        const frame = terminal.element;
        if (frame) frame.style.paddingInline = "";
        const framePadding = frame ? paddingOf(frame) : { width: 0, height: 0 };
        const available = {
          width: mount.clientWidth - padding.width - framePadding.width,
          height: mount.clientHeight - padding.height - framePadding.height,
        };
        // What the mount must be for the screen to spend the width it has, padding included,
        // because that is what the pane holding it can act on. NOT the height at the base size:
        // asking for that is asking to stay at the base size forever, since the fit below would
        // then find the height exactly binding every time.
        const wanted = preferredScreenHeight({
          baseFontSize: BASE_FONT_SIZE,
          cell: baseCell,
          grid,
          availableWidth: available.width,
          maximum: MAXIMUM_FONT_SIZE,
          minimum: MINIMUM_FONT_SIZE,
        });
        if (wanted !== null) {
          setContentHeight(wanted + padding.height + framePadding.height);
        }
        const fitted = fittedFontSize({
          baseFontSize: BASE_FONT_SIZE,
          cell: baseCell,
          grid,
          available,
          maximum: MAXIMUM_FONT_SIZE,
          minimum: MINIMUM_FONT_SIZE,
        });
        // Nothing measurable to fit against, which is every render before the mount has a size.
        if (fitted === null) return;
        if (fitted !== terminal.options.fontSize) terminal.options.fontSize = fitted;
        // Then settle it against the real metrics, because a cell is not proportional to its font:
        // measured on this pane, 13pt gives a cell 16 tall and 28pt gives 35.5, where the ratio
        // predicts 34.5. The arithmetic above is therefore a starting point that can overshoot by a
        // few percent -- enough for a scrollbar -- and xterm updates `dimensions` synchronously
        // with the option, so the overshoot is readable straight away. Only ever downward, so this
        // settles instead of hunting.
        for (let step = 0; step < 6; step += 1) {
          // Annotated because the assignment below feeds back into inferring this.
          const size: number = terminal.options.fontSize ?? BASE_FONT_SIZE;
          // The floor binds here too. This loop only ever shrinks, so without the guard it walks
          // straight back through a floored fit to whatever fits exactly -- measured on an
          // 80-column pane in a card's band: the fit floored at 11 and this settled it to 9.4.
          // Below the floor the answer is to overflow and scroll, not to keep shrinking.
          if (size <= Math.max(MINIMUM_FONT_SIZE, FONT_SIZE_STEP)) break;
          const actual = terminal.dimensions?.css.cell;
          if (!actual) break;
          // At or above 1 the screen fits; below it, it is the fraction of the size that would.
          const headroom = Math.min(
            available.width / (actual.width * grid.columns),
            available.height / (actual.height * grid.rows),
          );
          // A hair of tolerance, for the same reason the fit itself carries one: an exact fit
          // computes as 0.99999 often enough to cost a step for nothing.
          if (headroom >= 0.999) break;
          // Re-solved from the size actually in force rather than stepped down blindly, so an
          // overshoot of any size is answered in one move; the second term only guarantees the
          // loop moves at all when the solve rounds back to where it started.
          const solved = floorToStep(size * headroom);
          const next = Math.max(
            MINIMUM_FONT_SIZE,
            FONT_SIZE_STEP,
            solved < size ? solved : floorToStep(size - FONT_SIZE_STEP),
          );
          if (next >= size) break;
          terminal.options.fontSize = next;
        }
        const settled = terminal.dimensions?.css.cell;
        if (frame && settled) {
          const inset = surfaceInset({
            availableWidth: available.width,
            screenWidth: settled.width * grid.columns,
            basePadding: framePadding.width / 2,
          });
          frame.style.paddingInline = inset === null ? "" : `${inset}px`;
        }
      };

      // A fixed grid has nothing to observe: its size is the one it was given, and re-fitting it
      // would push a new size onto the PTY every time the page reflowed. A tmux attach does both,
      // in that order: the type follows the new box IMMEDIATELY, so a card being dragged stays
      // readable throughout, and the pane is asked to take the new shape on the debounce behind
      // it. The fit is what covers the case where the pane refuses -- a session somebody else is
      // attached to still gets a box-sized picture, just by scaling rather than by reshaping.
      const observer = paneAuthoritative
        ? new ResizeObserver(() => { fitType(); scheduleViewport(); })
        : sizing.kind === "fit"
          ? new ResizeObserver(() => scheduleViewport())
          : null;
      observer?.observe(mount);

      const initial = sizing.kind === "fixed"
        ? { columns: sizing.columns, rows: sizing.rows }
        : proposedDimensions(terminal, mount) ?? { columns: 80, rows: 24 };
      void feed.openTerminal(context, initial.columns, initial.rows)
        .then((opened) => {
          if (disposed) {
            release(opened.terminalId);
            return;
          }
          descriptor = opened;
          terminal.resize(opened.columns, opened.rows);
          // The grid a tmux attach ends up with comes from HERE, not from a checkpoint: the
          // history is imported rather than replayed, so `checkpointBegin` never arrives and this
          // is the only place the far end's shape is learned.
          fitType();
          // Queued before the subscription's writes, so the history lands above the live output
          // rather than racing it. The queue is what orders them; the fetch inside it can take as
          // long as it likes.
          const imported = isTmuxAttach(context);
          if (imported) {
            enqueueWrite(async () => {
              const encoded = await feed.terminalHistory(opened.terminalId, HISTORY_LINES);
              if (!encoded) return;
              await new Promise<void>((resolve) => {
                terminal.write(bytesFromBase64(encoded), resolve);
              });
            });
          }
          // A replay would clear the terminal first, erasing the history just written. The capture
          // already ends with the current screen, so there is nothing left for it to add.
          unsubscribe = feed.subscribeTerminal(opened.terminalId, {
            onMessage: receive,
            onError: (reason) => fail(new Error(reason)),
          }, { replay: !imported });
          onState?.(context, { kind: "ready", descriptor: opened });
          terminal.focus();
          // An attach has no checkpoint to wait for -- the capture above IS its first screen -- so
          // nothing else would ever move the label off "Opening terminal", and a terminal that is
          // attached and reading claims to be still opening.
          if (imported) {
            setSyncLabel("Attached");
            setSourceLabel(`Source ${opened.columns}×${opened.rows}`);
          }
          // The first report, which is what tells a claiming surface's pane to take this shape and
          // a following one what shape the pane already is.
          scheduleViewport();
        })
        .catch(fail);

      // Closing the tab runs no React cleanup, so without this the sidecar never hears that the
      // viewer left: the PTY session stays, and for a tmux attach that means a client nobody is
      // watching goes on holding the window at the tile's size. Measured that way before it
      // existed. `closeTerminal` is sent with keepalive so the browser does not cancel it on the
      // way out.
      const onPageHide = (): void => {
        if (descriptor && !remoteClosed) release(descriptor.terminalId);
      };
      window.addEventListener("pagehide", onPageHide);

      const appearance = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
      const updateTheme = (): void => {
        terminal.options.theme = terminalTheme();
      };
      appearance?.addEventListener("change", updateTheme);

      teardown = () => {
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        observer?.disconnect();
        mount.removeEventListener("touchstart", noteTouchStart);
        mount.removeEventListener("touchend", focusOnTap);
        textarea?.removeEventListener("focus", noteFocus);
        textarea?.removeEventListener("blur", noteBlur);
        sendRef.current = null;
        input.dispose();
        binaryInput.dispose();
        appearance?.removeEventListener("change", updateTheme);
        window.removeEventListener("pagehide", onPageHide);
        unsubscribe?.();
        if (descriptor && !remoteClosed) release(descriptor.terminalId);
        terminal.dispose();
      };
    }).catch(fail);

    return () => {
      disposed = true;
      teardown();
    };
    // Keyed by what the terminal points at rather than by the context object, which is rebuilt on
    // every render and would restart the session each time.
  }, [terminalContextKey(context), sizingKey(sizing), paneShape, feed, onState]);

  return {
    mountRef,
    labels: {
      sync: syncLabel,
      ownership: ownershipLabel,
      source: sourceLabel,
      view: viewLabel,
    },
    contentHeight,
    focused,
    modifiers,
    toggleModifier: (modifier) =>
      setModifiers((current) => ({ ...current, [modifier]: cycleModifier(current[modifier]) })),
    pressKey: (key) => {
      const held = heldModifiers(modifiersRef.current);
      sendRef.current?.(bytesForRailKey(key, held));
      setModifiers(releaseArmed);
    },
  };
}

/** The sizing values, not the object, so a re-render with the same numbers does not restart. */
function sizingKey(sizing: TerminalSizing): string {
  return sizing.kind === "fixed" ? `fixed:${sizing.columns}x${sizing.rows}` : "fit";
}


/**
 * How many cells this viewer's box holds.
 *
 * `at` is the cell to measure in, for a caller that must not be answered in the cell currently
 * rendered: a fitted terminal has already shrunk its type to hold an oversized grid, so measuring
 * in that cell returns the oversized grid back. Omitted, it measures what is on screen.
 */
function proposedDimensions(
  terminal: XtermTerminal,
  mount: HTMLElement,
  at: { width: number; height: number } | null = null,
): Dimensions | null {
  if (mount.clientWidth <= 0 || mount.clientHeight <= 0) return null;
  const cell = at ?? terminal.dimensions?.css.cell;
  if (!cell || cell.width <= 0 || cell.height <= 0) return null;
  const terminalElement = terminal.element;
  if (!terminalElement) return null;
  const style = getComputedStyle(terminalElement);
  const horizontalPadding = pixelValue(style.paddingLeft) + pixelValue(style.paddingRight);
  const verticalPadding = pixelValue(style.paddingTop) + pixelValue(style.paddingBottom);
  const scrollbarWidth = terminal.options.scrollback === 0
    || terminal.options.scrollbar?.showScrollbar === false
    ? 0
    : terminal.options.scrollbar?.width ?? 14;
  return {
    columns: Math.max(2, Math.floor((mount.clientWidth - horizontalPadding - scrollbarWidth) / cell.width)),
    rows: Math.max(1, Math.floor((mount.clientHeight - verticalPadding) / cell.height)),
  };
}

/** A box's padding, in CSS pixels, as one pair. */
function paddingOf(element: HTMLElement): { width: number; height: number } {
  const style = getComputedStyle(element);
  return {
    width: pixelValue(style.paddingLeft) + pixelValue(style.paddingRight),
    height: pixelValue(style.paddingTop) + pixelValue(style.paddingBottom),
  };
}

function pixelValue(value: string): number {
  return Number.parseInt(value, 10) || 0;
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64FromBinaryString(value: string): string {
  return btoa(value);
}

function terminalTheme() {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? {
        background: "#0b0e14",
        foreground: "#d8dee9",
        cursor: "#a8c7fa",
        selectionBackground: "#45658d99",
        black: "#1b1d23",
        red: "#e06c75",
        green: "#98c379",
        yellow: "#e5c07b",
        blue: "#61afef",
        magenta: "#c678dd",
        cyan: "#56b6c2",
        white: "#d4d7dd",
      }
    : {
        background: "#ffffff",
        foreground: "#2a2f38",
        cursor: "#2a6fdb",
        selectionBackground: "#b6d2ff80",
        black: "#383a42",
        red: "#d13b30",
        green: "#3f8f3c",
        yellow: "#9a6a00",
        blue: "#2a6fdb",
        magenta: "#9b2bb0",
        cyan: "#0a7d8c",
        white: "#a0a1a7",
      };
}
