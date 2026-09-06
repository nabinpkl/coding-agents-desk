import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { AgentTerminalContext } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "../activity-feed/data-source/SidecarDataSource";
import { terminalContextLabel } from "./terminalContext";
import { useAgentTerminal, type AgentTerminalState } from "./useAgentTerminal";

const MINIMUM_TERMINAL_HEIGHT = 150;
const MAXIMUM_TERMINAL_SHARE = 0.72;
const BAND_TERMINAL_SHARE = 0.42;

/** 0 rather than NaN off a window, so every share of it clamps to the minimum instead. */
const viewportHeight = (): number => globalThis.innerHeight || 0;

interface Props {
  feed: SidecarDataSource;
  context: AgentTerminalContext;
  onState: (context: AgentTerminalContext, state: AgentTerminalState) => void;
  /**
   * Where the pane's height comes from, which also decides which way a drag grows.
   *
   * `column` (the default) is a pane sharing a fixed-height column with a transcript, so it
   * opens at a share of that column and its ceiling is a share of it too.
   *
   * `band` is a pane whose own height IS the height of the band holding it. Nothing reserves a
   * box around it -- a share of the parent would measure the pane itself, and a reserved box
   * leaves whatever the pane does not fill blank -- so it opens at a share of the viewport and
   * takes its ceiling from there too. Growing it makes the band taller, which moves the band's
   * top edge up: the direction a handle along the pane's top edge implies.
   */
  layout?: "column" | "band";
}

/** The resizable terminal under one thread. The protocol is the hook's; this is its chrome. */
export function AgentTerminalPane({ feed, context, onState, layout = "column" }: Props) {
  const paneRef = useRef<HTMLDivElement>(null);
  const removeResizeListenersRef = useRef<() => void>(() => {});
  const band = layout === "band";
  const [height, setHeight] = useState<number | null>(
    band
      ? Math.max(MINIMUM_TERMINAL_HEIGHT, Math.round(viewportHeight() * BAND_TERMINAL_SHARE))
      : null,
  );
  const { mountRef, labels } = useAgentTerminal({ feed, context, sizing: { kind: "fit" }, onState });

  const ceiling = (): number => {
    const available = band
      ? viewportHeight()
      : (paneRef.current?.parentElement?.clientHeight ?? 0);
    return Math.max(MINIMUM_TERMINAL_HEIGHT, available * MAXIMUM_TERMINAL_SHARE);
  };

  const resizeTo = (requestedHeight: number): void => {
    if (!paneRef.current) return;
    setHeight(Math.min(ceiling(), Math.max(MINIMUM_TERMINAL_HEIGHT, requestedHeight)));
  };

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const pane = paneRef.current;
    if (!pane) return;
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
    if (!pane) return;
    const currentHeight = pane.getBoundingClientRect().height;
    let nextHeight: number | null = null;
    if (event.key === "ArrowUp") nextHeight = currentHeight + 24;
    if (event.key === "ArrowDown") nextHeight = currentHeight - 24;
    if (event.key === "Home") nextHeight = MINIMUM_TERMINAL_HEIGHT;
    if (event.key === "End") nextHeight = ceiling();
    if (nextHeight === null) return;
    event.preventDefault();
    resizeTo(nextHeight);
  };

  return (
    <section
      ref={paneRef}
      aria-label={`${terminalContextLabel(context)} terminal`}
      className={`flex min-h-[150px] shrink-0 flex-col border-t border-border bg-white dark:bg-[#0b0e14] ${
        band ? "" : "h-[38%]"
      }`}
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
      {/* Scrolls rather than clips: a tmux attach renders at the pane's geometry, which is not
          this pane's, and clipping it hid the part of the screen the cursor was on. */}
      <div ref={mountRef} className="min-h-0 flex-1 overflow-auto px-1 pb-1" />
      <footer className="flex min-h-6 shrink-0 items-center gap-3 overflow-hidden border-t border-border px-2 font-mono text-[10px] text-muted-foreground">
        <span>{labels.sync}</span>
        {labels.ownership ? <span>{labels.ownership}</span> : null}
        {labels.source ? <span>{labels.source}</span> : null}
        {labels.view ? <span>{labels.view}</span> : null}
      </footer>
    </section>
  );
}

