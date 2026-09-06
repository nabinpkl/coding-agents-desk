import { useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type {
  AgentTerminalContext,
  AgentTerminalDescriptor,
  AgentTerminalStreamMessage,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "../activity-feed/data-source/SidecarDataSource";
import { terminalContextKey } from "./terminalContext";

export type AgentTerminalState =
  | { kind: "ready"; descriptor: AgentTerminalDescriptor }
  | { kind: "error"; message: string }
  | { kind: "ended"; exitStatus?: number };

/**
 * How the terminal decides its own grid.
 *
 * `fit` measures the mount and follows it, which is what a single resizable pane wants. `fixed`
 * pins the grid, which is what a wall of them needs: a tile that re-fits would renegotiate the
 * PTY size on every layout change, and for a tmux target that means resizing the window in
 * whatever terminal the user has it open in as well.
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

/**
 * One xterm bound to one sidecar terminal: the stream, the input, the size negotiation, the theme.
 *
 * Extracted from the resizable pane when a grid of terminals needed the same protocol without the
 * same chrome. The alternative was a second copy of the checkpoint/output/viewport switch, which is
 * the part where a divergence would be invisible until a screen failed to paint.
 */
export function useAgentTerminal({ feed, context, sizing, onState }: {
  feed: SidecarDataSource;
  context: AgentTerminalContext;
  sizing: TerminalSizing;
  onState: (context: AgentTerminalContext, state: AgentTerminalState) => void;
}): { mountRef: RefObject<HTMLDivElement | null>; labels: TerminalLabels } {
  const mountRef = useRef<HTMLDivElement>(null);
  const [syncLabel, setSyncLabel] = useState("Opening terminal");
  const [ownershipLabel, setOwnershipLabel] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [viewLabel, setViewLabel] = useState("");

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    let teardown = (): void => {};
    const fail = (error: unknown): void => {
      if (disposed) return;
      onState(context, { kind: "error", message: String((error as Error).message ?? error) });
    };

    void loadXterm().then(({ Terminal }) => {
      if (disposed) return;
      const terminal = new Terminal({
        allowProposedApi: false,
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
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

      let descriptor: AgentTerminalDescriptor | null = null;
      let unsubscribe: (() => void) | null = null;
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      let viewportSequence = 0;
      let remoteClosed = false;
      let writes = Promise.resolve();

      const enqueueWrite = (operation: () => void | Promise<void>): void => {
        writes = writes.then(operation).catch(fail);
      };
      const write = (encoded: string): void => {
        enqueueWrite(() => new Promise<void>((resolve) => terminal.write(bytesFromBase64(encoded), resolve)));
      };
      const publishViewport = (claim: boolean): void => {
        if (!descriptor || disposed || remoteClosed) return;
        const dimensions = sizing.kind === "fixed"
          ? { columns: sizing.columns, rows: sizing.rows }
          : proposedDimensions(terminal, mount);
        if (!dimensions) return;
        viewportSequence += 1;
        setViewLabel(`View ${dimensions.columns}×${dimensions.rows}`);
        void feed.updateTerminalViewport(descriptor.terminalId, {
          sequence: String(viewportSequence),
          active: true,
          claim,
          ...dimensions,
        }).catch(fail);
      };
      const scheduleViewport = (claim = false): void => {
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => publishViewport(claim), 120);
      };
      const finishRemote = (state: AgentTerminalState): void => {
        remoteClosed = true;
        unsubscribe?.();
        unsubscribe = null;
        onState(context, state);
      };
      // A resumed CLI is worth keeping alive for the next visit, so its viewer leaving is a
      // detach. An attach is not: the PTY session outliving its viewer means the tmux client stays
      // connected, and a client that nobody is watching still holds the window at the tile's size
      // in whatever terminal the user has that session open in. Killing ends the attach; the tmux
      // session it was attached to is untouched.
      const closeMode = context.kind === "tmux" ? "kill" : "detach";
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
            });
            break;
          case "checkpointChunk":
          case "output":
            write(message.data);
            break;
          case "checkpointEnd":
            enqueueWrite(() => {
              setSyncLabel(`Revision ${message.revision}`);
              scheduleViewport(true);
            });
            break;
          case "viewport":
            setOwnershipLabel(
              message.isOwner
                ? "Controls layout"
                : message.ownerClientId !== "0"
                  ? `Following ${message.ownerTitle || "viewer"}`
                  : "Source frozen",
            );
            setSourceLabel(`Source ${message.sourceColumns}×${message.sourceRows}`);
            setViewLabel(`View ${message.viewColumns}×${message.viewRows}`);
            break;
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

      const input = terminal.onData((data) => {
        if (!descriptor || remoteClosed) return;
        void feed.sendTerminalInput(descriptor.terminalId, data).catch(fail);
      });
      const binaryInput = terminal.onBinary((data) => {
        if (!descriptor || remoteClosed) return;
        void feed.sendTerminalInput(descriptor.terminalId, base64FromBinaryString(data), "base64")
          .catch(fail);
      });
      // A fixed grid has nothing to observe: its size is the one it was given, and re-fitting it
      // would push a new size onto the PTY every time the page reflowed.
      const observer = sizing.kind === "fit" ? new ResizeObserver(() => scheduleViewport()) : null;
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
          // Queued before the subscription's writes, so the history lands above the live output
          // rather than racing it. The queue is what orders them; the fetch inside it can take as
          // long as it likes.
          const imported = context.kind === "tmux";
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
          onState(context, { kind: "ready", descriptor: opened });
          terminal.focus();
          scheduleViewport(true);
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
  }, [terminalContextKey(context), sizingKey(sizing), feed, onState]);

  return {
    mountRef,
    labels: {
      sync: syncLabel,
      ownership: ownershipLabel,
      source: sourceLabel,
      view: viewLabel,
    },
  };
}

/** The sizing values, not the object, so a re-render with the same numbers does not restart. */
function sizingKey(sizing: TerminalSizing): string {
  return sizing.kind === "fixed" ? `fixed:${sizing.columns}x${sizing.rows}` : "fit";
}


function proposedDimensions(terminal: XtermTerminal, mount: HTMLElement): Dimensions | null {
  if (mount.clientWidth <= 0 || mount.clientHeight <= 0) return null;
  const cell = terminal.dimensions?.css.cell;
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
