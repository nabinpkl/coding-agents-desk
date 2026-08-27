import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type {
  AgentTerminalContext,
  AgentTerminalDescriptor,
  AgentTerminalStreamMessage,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "../activity-feed/data-source/SidecarDataSource";

const MINIMUM_TERMINAL_HEIGHT = 150;
const MAXIMUM_TERMINAL_SHARE = 0.72;

export type AgentTerminalPaneState =
  | { kind: "ready"; descriptor: AgentTerminalDescriptor }
  | { kind: "error"; message: string }
  | { kind: "ended"; exitStatus?: number };

interface Props {
  feed: SidecarDataSource;
  context: AgentTerminalContext;
  onState: (context: AgentTerminalContext, state: AgentTerminalPaneState) => void;
}

interface Dimensions {
  columns: number;
  rows: number;
}

export function AgentTerminalPane({ feed, context, onState }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const removeResizeListenersRef = useRef<() => void>(() => {});
  const [height, setHeight] = useState<number | null>(null);
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

    void import("@xterm/xterm").then(({ Terminal }) => {
      if (disposed) return;
      const terminal = new Terminal({
        allowProposedApi: false,
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        lineHeight: 1.08,
        scrollback: 2_000,
        theme: terminalTheme(),
      });
      terminal.open(mount);

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
        const dimensions = proposedDimensions(terminal, mount);
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
      const finishRemote = (state: AgentTerminalPaneState): void => {
        remoteClosed = true;
        unsubscribe?.();
        unsubscribe = null;
        onState(context, state);
      };
      const detach = (terminalId: string): void => {
        void feed.closeTerminal(terminalId, "detach").catch((error) => {
          console.error("Agent terminal detach failed", error);
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
      const observer = new ResizeObserver(() => scheduleViewport());
      observer.observe(mount);

      const initial = proposedDimensions(terminal, mount) ?? { columns: 80, rows: 24 };
      void feed.openTerminal(context, initial.columns, initial.rows)
        .then((opened) => {
          if (disposed) {
            detach(opened.terminalId);
            return;
          }
          descriptor = opened;
          terminal.resize(opened.columns, opened.rows);
          unsubscribe = feed.subscribeTerminal(opened.terminalId, {
            onMessage: receive,
            onError: (reason) => fail(new Error(reason)),
          });
          onState(context, { kind: "ready", descriptor: opened });
          terminal.focus();
          scheduleViewport(true);
        })
        .catch(fail);

      const appearance = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
      const updateTheme = (): void => {
        terminal.options.theme = terminalTheme();
      };
      appearance?.addEventListener("change", updateTheme);

      teardown = () => {
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        observer.disconnect();
        input.dispose();
        binaryInput.dispose();
        appearance?.removeEventListener("change", updateTheme);
        unsubscribe?.();
        if (descriptor && !remoteClosed) detach(descriptor.terminalId);
        terminal.dispose();
      };
    }).catch(fail);

    return () => {
      disposed = true;
      removeResizeListenersRef.current();
      teardown();
    };
  }, [context.projectPath, context.sessionId, context.source, feed, onState]);

  const resizeTo = (requestedHeight: number): void => {
    const pane = paneRef.current;
    const column = pane?.parentElement;
    if (!pane || !column) return;
    const maximum = Math.max(MINIMUM_TERMINAL_HEIGHT, column.clientHeight * MAXIMUM_TERMINAL_SHARE);
    setHeight(Math.min(maximum, Math.max(MINIMUM_TERMINAL_HEIGHT, requestedHeight)));
  };

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const pane = paneRef.current;
    const column = pane?.parentElement;
    if (!pane || !column) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = pane.getBoundingClientRect().height;
    const move = (moveEvent: PointerEvent): void => {
      resizeTo(startHeight - (moveEvent.clientY - startY));
    };
    const finish = (): void => {
      globalThis.removeEventListener("pointermove", move);
      globalThis.removeEventListener("pointerup", finish);
      globalThis.removeEventListener("pointercancel", finish);
      removeResizeListenersRef.current = () => {};
    };
    removeResizeListenersRef.current();
    removeResizeListenersRef.current = finish;
    globalThis.addEventListener("pointermove", move);
    globalThis.addEventListener("pointerup", finish, { once: true });
    globalThis.addEventListener("pointercancel", finish, { once: true });
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const pane = paneRef.current;
    const column = pane?.parentElement;
    if (!pane || !column) return;
    const currentHeight = pane.getBoundingClientRect().height;
    const maximum = Math.max(MINIMUM_TERMINAL_HEIGHT, column.clientHeight * MAXIMUM_TERMINAL_SHARE);
    let nextHeight: number | null = null;
    if (event.key === "ArrowUp") nextHeight = currentHeight + 24;
    if (event.key === "ArrowDown") nextHeight = currentHeight - 24;
    if (event.key === "Home") nextHeight = MINIMUM_TERMINAL_HEIGHT;
    if (event.key === "End") nextHeight = maximum;
    if (nextHeight === null) return;
    event.preventDefault();
    resizeTo(nextHeight);
  };

  return (
    <section
      ref={paneRef}
      aria-label={`${context.source === "claude" ? "Claude" : "Codex"} terminal`}
      className="flex h-[38%] min-h-[150px] shrink-0 flex-col border-t border-border bg-white dark:bg-[#0b0e14]"
      style={height === null ? undefined : { height }}
    >
      <button
        type="button"
        role="separator"
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
        className="group relative h-2 shrink-0 cursor-row-resize bg-card focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="absolute inset-x-0 top-0 h-px bg-border transition-colors group-hover:bg-primary" />
      </button>
      <div ref={mountRef} className="min-h-0 flex-1 overflow-hidden px-1 pb-1" />
      <footer className="flex min-h-6 shrink-0 items-center gap-3 overflow-hidden border-t border-border px-2 font-mono text-[10px] text-muted-foreground">
        <span>{syncLabel}</span>
        {ownershipLabel ? <span>{ownershipLabel}</span> : null}
        {sourceLabel ? <span>{sourceLabel}</span> : null}
        {viewLabel ? <span>{viewLabel}</span> : null}
      </footer>
    </section>
  );
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
