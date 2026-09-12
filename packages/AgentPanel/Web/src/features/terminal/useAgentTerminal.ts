import { useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type {
  AgentTerminalContext,
  AgentTerminalDescriptor,
  AgentTerminalStreamMessage,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import {
  cycleModifier,
  heldModifiers,
  RAIL_MODIFIERS_OFF,
  releaseArmed,
  type ModifierState,
} from "@/features/keyboard/modifierLatch";
import { isTmuxAttach, terminalContextKey } from "@/features/terminal/terminalContext";
import {
  FONT_SIZE_STEP,
  fittedFontSize,
  floorToStep,
  preferredScreenHeight,
  surfaceInset,
  viewerSetsGrid,
} from "@/features/terminal/terminalTypeFit";
import {
  applyModifiers,
  bytesForRailKey,
  type RailKey,
  type RailModifier,
  type RailModifiers,
} from "@agentdesk/agent-feed-wire";
import type {
  AgentTerminal,
  AgentTerminalState,
  Dimensions,
  TerminalLabels,
  TerminalSizing,
} from "@/features/terminal/agentTerminalTypes";
import { createTerminalFit } from "@/features/terminal/agentTerminalFit";
import type { TerminalRuntime } from "@/features/terminal/agentTerminalRuntime";
import { createTerminalReceive } from "@/features/terminal/agentTerminalStream";
import {
  BASE_FONT_SIZE,
  bytesFromBase64,
  base64FromBinaryString,
  DEFAULT_GRID,
  HISTORY_LINES,
  loadXterm,
  MAXIMUM_FONT_SIZE,
  MINIMUM_FONT_SIZE,
  paddingOf,
  proposedDimensions,
  sizingKey,
  TAP_SLOP_PX,
  TERMINAL_ZOOM,
  terminalTheme,
  WHEEL_LINES,
} from "@/features/terminal/agentTerminalLayout";

// Re-exported: the panes that mount a terminal import the hook, and these are what they
// hand it or read from it.
export type {
  AgentTerminal,
  AgentTerminalState,
  TerminalLabels,
  TerminalSizing,
} from "@/features/terminal/agentTerminalTypes";
export { TERMINAL_ZOOM } from "@/features/terminal/agentTerminalLayout";

export function useAgentTerminal(
  { feed, context, sizing, paneShape = "adopt", zoom = null, onState }: {
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
  /**
   * The size the reader has chosen, or null to size the type to the box.
   *
   * A choice outranks the fit entirely: the screen is drawn at this size and overflows where it
   * does not fit, which is the point of choosing one larger than the box. Held in a ref inside, so
   * changing it re-fits rather than tearing the terminal down and re-attaching to the pane.
   */
  zoom?: number | null;
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
  /** The size actually in force, so the chrome can label what a zoom is moving. */
  const [fontSize, setFontSize] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [modifiers, setModifiers] = useState<Record<RailModifier, ModifierState>>(RAIL_MODIFIERS_OFF);
  // The effect's `onData` reads the latch as it stands at the keystroke, not as it stood when the
  // terminal was created, and the effect deliberately does not re-run on a modifier press: that
  // would tear down the session to answer a Ctrl tap.
  const modifiersRef = useRef(modifiers);
  modifiersRef.current = modifiers;
  // Same shape as the modifier latch above and for the same reason: the fit reads the choice as it
  // stands, and the effect must not re-run on a zoom press -- that would tear down the attachment
  // and re-import the whole scrollback to answer a button.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** The live `fitType`, so a zoom can re-run it without owning any of what it closes over. */
  const refitRef = useRef<(() => void) | null>(null);
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
      const t = {} as TerminalRuntime;
      t.unsubscribe = null;
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      // The cell at the BASE type size, measured once by `fitType`. Kept up here because two
      // readers need it: the fit itself, and the viewport report, which must describe the box in
      // grid cells the far end can act on rather than in whatever the fit has shrunk them to.
      t.baseCell = null;
      // Whether the far end took the shape this viewer asked for. What it decides is which of TWO
      // ways of making a screen fit a box is in force, and only ever one of them: see `fitType`.
      //
      // A tmux pane answers this in its own report, so it starts false and follows what arrives.
      // Nothing else has a second viewer to lose to, and starting those false was the fault: it
      // ran the fit as well as the grid proposal on a terminal only this box was sizing.
      t.ownsPaneShape = viewerSetsGrid(isTmuxAttach(context), sizing.kind);
      let viewportSequence = 0;
      t.remoteClosed = false;
      let writes = Promise.resolve();

      const enqueueWrite = (operation: () => void | Promise<void>): void => {
        writes = writes.then(operation).catch(fail);
      };
      const write = (encoded: string): void => {
        enqueueWrite(() => new Promise<void>((resolve) => terminal.write(bytesFromBase64(encoded), resolve)));
      };
      const publishViewport = (): void => {
        if (!descriptor || disposed || t.remoteClosed) return;
        // What this viewer's BOX would hold, which is what the far end resizes to. A viewer that
        // does not set the grid has scaled its type to squeeze an oversized one in, so it must
        // measure at the BASE cell: reporting the fitted one describes the grid already in force
        // and asks the pane to stay exactly as it is. A viewer that does set the grid has not
        // scaled anything -- its cell is the base one, or the size its reader asked for -- and the
        // cell on screen is the one the answer should be in. `baseCell` is null only before the
        // first fit, when nothing has been scaled and the current cell IS the base one.
        const dimensions = sizing.kind === "fixed"
          ? { columns: sizing.columns, rows: sizing.rows }
          : proposedDimensions(terminal, mount, t.ownsPaneShape ? null : t.baseCell);
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
        t.remoteClosed = true;
        t.unsubscribe?.();
        t.unsubscribe = null;
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
      // Staged: the parts call these, and none of them exists until the lines above have run.
      Object.assign(t, {
        terminal,
        mount,
        zoomRef,
        adoptsPaneShape,
        paneAuthoritative,
        dimensions: null,
        moved: false,
        enqueueWrite,
        write,
        scheduleViewport,
        finishRemote,
        fail,
        fitType: () => {},
        setContentHeight,
        setFontSize,
        setOwnershipLabel,
        setSourceLabel,
        setSyncLabel,
        setViewLabel,
      });
      const receive = createTerminalReceive(t);
      const fitType = createTerminalFit(t);
      t.fitType = fitType;


      const send = (data: string): void => {
        if (!descriptor || t.remoteClosed) return;
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
        if (!descriptor || t.remoteClosed) return;
        void feed.sendTerminalInput(descriptor.terminalId, base64FromBinaryString(data), "base64")
          .catch(fail);
      });

      // A fixed grid has nothing to observe: its size is the one it was given, and re-fitting it
      // would push a new size onto the PTY every time the page reflowed. A tmux attach does both,
      // in that order: the type follows the new box IMMEDIATELY, so a card being dragged stays
      // readable throughout, and the pane is asked to take the new shape on the debounce behind
      // it. The fit is what covers the case where the pane refuses -- a session somebody else is
      // attached to still gets a box-sized picture, just by scaling rather than by reshaping.
      refitRef.current = fitType;
      const observer = paneAuthoritative
        ? new ResizeObserver(() => { fitType(); scheduleViewport(); })
        : sizing.kind === "fit"
          ? new ResizeObserver(() => scheduleViewport())
          : null;
      observer?.observe(mount);

      const initial = sizing.kind === "fixed"
        ? { columns: sizing.columns, rows: sizing.rows }
        // A follower does not impose its box on an existing pane, and must not impose it on one
        // being created either -- that is the same imposition, made permanent.
        : adoptsPaneShape
        ? proposedDimensions(terminal, mount) ?? DEFAULT_GRID
        : DEFAULT_GRID;
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
          t.unsubscribe = feed.subscribeTerminal(opened.terminalId, {
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
        if (descriptor && !t.remoteClosed) release(descriptor.terminalId);
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
        t.unsubscribe?.();
        if (descriptor && !t.remoteClosed) release(descriptor.terminalId);
        terminal.dispose();
      };
    }).catch(fail);

    return () => {
      disposed = true;
      refitRef.current = null;
      teardown();
    };
    // Keyed by what the terminal points at rather than by the context object, which is rebuilt on
    // every render and would restart the session each time.
  }, [terminalContextKey(context), sizingKey(sizing), paneShape, feed, onState]);

  // A zoom press changes nothing the effect above owns, so it re-fits in place rather than being a
  // dependency of it: as a dependency it would dispose the terminal, re-open the pane and re-import
  // the whole scrollback to answer a button.
  useEffect(() => {
    refitRef.current?.();
  }, [zoom]);

  return {
    mountRef,
    labels: {
      sync: syncLabel,
      ownership: ownershipLabel,
      source: sourceLabel,
      view: viewLabel,
    },
    contentHeight,
    fontSize,
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
