// The cursor reconciliation, replayed against the Swift client's own tests
// (`client/AgentDeskClientTests/CursorReconciliationStateMachineTests.swift`), times in ms.

import { describe, expect, it } from "vitest";
import { CursorReconciliation } from "@/features/desktop-viewer/pointer-input/cursorReconciliation";

const clamp = ({ x, y }: { x: number; y: number }) => ({
  x: Math.min(Math.max(0, x), 199),
  y: Math.min(Math.max(0, y), 149),
});
const move = (dx: number, dy: number) => ({ kind: "move" as const, dx, dy });

describe("CursorReconciliation, from the Swift tests", () => {
  it("staleAppliedRevisionAdvancesProgressWithoutRewindingPrediction", () => {
    const machine = new CursorReconciliation(1_000);
    const first = machine.record(move(10, 0), 0)!;
    const second = machine.record(move(20, 0), 100)!;
    expect(machine.applyHostApplied(first, { x: 10, y: 0 }, 200)).toBeNull();
    expect(machine.pendingRevisions).toEqual([second]);
    expect(machine.confidence).toBe("awaiting-host");
  });

  it("latestAppliedRevisionConfirmsAndReturnsAuthoritativePosition", () => {
    const machine = new CursorReconciliation(1_000);
    machine.record(move(10, 0), 0);
    const latest = machine.record(move(20, 0), 100)!;
    expect(machine.applyHostApplied(latest, { x: 29, y: 0 }, 200)).toEqual({ x: 29, y: 0 });
    expect(machine.pendingRevisions).toEqual([]);
    expect(machine.confidence).toBe("confirmed");
  });

  it("oldestPendingDeadlineIsNotExtendedByContinuedMovement", () => {
    const machine = new CursorReconciliation(1_000);
    machine.record(move(1, 0), 0);
    machine.record(move(1, 0), 900);
    machine.advance(1_010);
    expect(machine.confidence).toBe("ghost");
    expect(machine.ghostDeadline).toBe(1_000);
  });

  it("sendFailureGhostsImmediatelyAndLatestAckRecovers", () => {
    const machine = new CursorReconciliation(1_000);
    const revision = machine.record(move(1, 0), 0)!;
    machine.markSendFailed(revision);
    expect(machine.confidence).toBe("ghost");
    expect(machine.applyHostApplied(revision, { x: 1, y: 0 }, 100)).toEqual({ x: 1, y: 0 });
    expect(machine.confidence).toBe("confirmed");
  });

  it("hostMovementRebasesAndReplaysNewerClientOperations", () => {
    // Swift named the revision the host's move came after. On one ordered channel that
    // acknowledgement has already arrived, so it is applied first and the move names nothing.
    const machine = new CursorReconciliation(1_000);
    const first = machine.record(move(5, 0), 0)!;
    const second = machine.record(move(0, 3), 100)!;
    machine.applyHostApplied(first, { x: 5, y: 0 }, 150);
    expect(machine.applyHostMoved({ x: 100, y: 100 }, clamp, 200)).toEqual({ x: 100, y: 103 });
    expect(machine.pendingRevisions).toEqual([second]);
    expect(machine.confidence).toBe("awaiting-host");
  });

  it("hostMovementWithoutPendingInputIsImmediatelyAuthoritative", () => {
    const machine = new CursorReconciliation(1_000);
    expect(machine.applyHostMoved({ x: 80, y: 70 }, clamp, 2_000)).toEqual({ x: 80, y: 70 });
    expect(machine.confidence).toBe("confirmed");
  });

  it("duplicateAndFutureAppliedRevisionsCannotChangeState", () => {
    const machine = new CursorReconciliation(1_000);
    const revision = machine.record(move(2, 0), 0)!;
    expect(machine.applyHostApplied(revision + 1, { x: 99, y: 99 }, 100)).toBeNull();
    expect(machine.pendingRevisions).toEqual([revision]);
    machine.applyHostApplied(revision, { x: 2, y: 0 }, 200);
    expect(machine.applyHostApplied(revision, { x: 100, y: 100 }, 300)).toBeNull();
  });

  it("pendingWindowIsBoundedAndCapacityFailureGhosts", () => {
    const machine = new CursorReconciliation(1_000, 2);
    const first = machine.record(move(1, 0), 0)!;
    const second = machine.record(move(1, 0), 100)!;
    expect(machine.record(move(1, 0), 200)).toBeNull();
    expect(machine.pendingRevisions).toEqual([first, second]);
    expect(machine.confidence).toBe("ghost");
    machine.applyHostApplied(second, { x: 2, y: 0 }, 300);
    expect(machine.confidence).toBe("confirmed");
  });

  it("resetClearsPendingStateAndRestartsRevisionSequence", () => {
    const machine = new CursorReconciliation(1_000);
    machine.record(move(1, 0), 0);
    machine.advance(2_000);
    machine.reset();
    expect(machine.pendingRevisions).toEqual([]);
    expect(machine.confidence).toBe("confirmed");
    expect(machine.record(move(2, 0), 3_000)).toBe(1);
  });
});
