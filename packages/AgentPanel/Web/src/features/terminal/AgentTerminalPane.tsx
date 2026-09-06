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

interface Props {
  feed: SidecarDataSource;
  context: AgentTerminalContext;
  onState: (context: AgentTerminalContext, state: AgentTerminalState) => void;
}

/** The resizable terminal under one thread. The protocol is the hook's; this is its chrome. */
export function AgentTerminalPane({ feed, context, onState }: Props) {
  const paneRef = useRef<HTMLDivElement>(null);
  const removeResizeListenersRef = useRef<() => void>(() => {});
  const [height, setHeight] = useState<number | null>(null);
  const { mountRef, labels } = useAgentTerminal({ feed, context, sizing: { kind: "fit" }, onState });

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
      aria-label={`${terminalContextLabel(context)} terminal`}
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
        <span>{labels.sync}</span>
        {labels.ownership ? <span>{labels.ownership}</span> : null}
        {labels.source ? <span>{labels.source}</span> : null}
        {labels.view ? <span>{labels.view}</span> : null}
      </footer>
    </section>
  );
}

