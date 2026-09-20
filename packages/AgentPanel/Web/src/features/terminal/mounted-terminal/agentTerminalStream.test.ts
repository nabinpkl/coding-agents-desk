import { expect, test, vi } from "vitest";
import { createTerminalReceive } from "@/features/terminal/mounted-terminal/agentTerminalStream";
import { createTerminalMouseMode } from "@/features/terminal/mounted-terminal/terminalMouseMode";
import type { TerminalRuntime } from "@/features/terminal/mounted-terminal/agentTerminalRuntime";

function runtimeWith(mouseReporting: boolean) {
  const written: unknown[] = [];
  const terminal = {
    clear: vi.fn(),
    reset: vi.fn(),
    resize: vi.fn(),
    fitType: vi.fn(),
    write: vi.fn((data: unknown) => written.push(data)),
  };
  const runtime = {
    terminal,
    enqueueWrite: (operation: () => void) => operation(),
    fitType: vi.fn(),
    scheduleViewport: vi.fn(),
    setSyncLabel: vi.fn(),
    setSourceLabel: vi.fn(),
    mouseMode: createTerminalMouseMode(mouseReporting),
  } as unknown as TerminalRuntime;
  return { runtime, terminal, written };
}

test("a checkpoint re-asserts the tracked mouse mode after the reset", () => {
  // The reset xterm needs on a checkpoint also wipes its internal mouse state, which is what
  // turned a finger into Up/Down arrows on a reopened tile. The assert puts it back.
  const { runtime, terminal } = runtimeWith(true);
  createTerminalReceive(runtime)({
    type: "checkpointBegin",
    checkpointId: "1",
    revision: "1",
    columns: 80,
    rows: 24,
    totalBytes: "0",
    chunkCount: 0,
    historyTruncated: false,
  });
  expect(terminal.reset).toHaveBeenCalledOnce();
  const asserted = terminal.write.mock.calls.map((call) => call[0]);
  expect(asserted).toHaveLength(1);
  expect(new TextDecoder().decode(asserted[0] as Uint8Array)).toBe("\u001b[?1002h\u001b[?1006h");
});

test("a checkpoint with the mouse off asserts nothing", () => {
  const { runtime, terminal } = runtimeWith(false);
  createTerminalReceive(runtime)({
    type: "checkpointBegin",
    checkpointId: "1",
    revision: "1",
    columns: 80,
    rows: 24,
    totalBytes: "0",
    chunkCount: 0,
    historyTruncated: false,
  });
  expect(terminal.reset).toHaveBeenCalledOnce();
  expect(terminal.write).not.toHaveBeenCalled();
});
