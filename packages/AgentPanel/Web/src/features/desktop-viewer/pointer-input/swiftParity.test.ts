// The numbers a finger is tuned against, checked against the Swift client they came from.
//
// The iPhone client (`client/AgentDeskClient/`) was tuned on a device and is the reference for
// how the web's trackpad, scroll strip and puck should feel. Its numbers cannot be imported, so
// this reads them out of the Swift source and fails when either side is retuned without the
// other. When `client/` is deleted, delete this with it: the web's values are then the only ones.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as gesture from "@/features/desktop-viewer/pointer-input/gestureConstants";
import {
  CURSOR_CONFIRMATION_TIMEOUT_MS,
  DEFAULT_PENDING_OPERATION_LIMIT,
} from "@/features/desktop-viewer/pointer-input/cursorReconciliation";
import {
  CURSOR_MIRROR_RENDER_SCALE,
  DEFAULT_POINTER_SCROLL_PUCK_OFFSET,
  POINTER_SCROLL_PUCK_SIDE,
} from "@/features/desktop-viewer/tile-viewport/tileViewportConstants";
import * as trackpad from "@/features/desktop-viewer/trackpad/trackpadConstants";

const CLIENT = resolve(process.cwd(), "../../../client/AgentDeskClient");

function swift(file: string): string {
  return readFileSync(resolve(CLIENT, file), "utf8");
}

/** The first number captured by `pattern` in `file`, underscores and all. */
function swiftNumber(file: string, pattern: RegExp): number {
  const match = pattern.exec(swift(file));
  if (!match?.[1]) throw new Error(`${file}: ${pattern} matched nothing; the Swift moved, update this check`);
  return Number(match[1].replaceAll("_", ""));
}

const NUMBER = String.raw`(-?[\d_]+(?:\.\d+)?)`;
const staticLet = (name: string) => new RegExp(String.raw`static let ${name}: [A-Za-z]+ = ${NUMBER}`);

describe("the web's gesture numbers are the Swift client's", () => {
  it("pointer slop and acceleration", () => {
    expect(gesture.POINTER_SLOP).toBe(swiftNumber("GestureTranslator.swift", staticLet("slopThreshold")));
    const mac =
      /static let mac = GestureAcceleration \{ velocity in\s+([\d.]+) \+ min\(velocity \* ([\d.]+), ([\d.]+)\)/.exec(
        swift("GestureTranslator.swift"),
      );
    expect(mac?.slice(1).map(Number)).toEqual([
      gesture.POINTER_ACCELERATION_FLOOR,
      gesture.POINTER_ACCELERATION_SLOPE,
      gesture.POINTER_ACCELERATION_CEILING,
    ]);
  });

  it("scroll acceleration, axis lock and coast", () => {
    const scroll =
      /static let scroll = GestureAcceleration \{ velocity in\s+([\d.]+) \+ min\(velocity \* ([\d.]+), ([\d.]+)\)/.exec(
        swift("GestureTranslator.swift"),
      );
    expect(scroll?.slice(1).map(Number)).toEqual([
      gesture.SCROLL_ACCELERATION_FLOOR,
      gesture.SCROLL_ACCELERATION_SLOPE,
      gesture.SCROLL_ACCELERATION_CEILING,
    ]);
    const translator = (name: string) => swiftNumber("GestureTranslator.swift", staticLet(name));
    expect(gesture.SCROLL_AXIS_SLOP).toBe(translator("scrollAxisSlop"));
    expect(gesture.SCROLL_AXIS_DOMINANCE_RATIO).toBe(translator("scrollAxisDominanceRatio"));
    expect(gesture.SCROLL_MOMENTUM_FLICK_THRESHOLD).toBe(translator("momentumFlickThreshold"));
    expect(gesture.SCROLL_MOMENTUM_STOP_THRESHOLD).toBe(translator("momentumStopThreshold"));
    expect(gesture.SCROLL_MOMENTUM_DECAY_K).toBe(translator("momentumDecayK"));
  });

  it("hold to drag and the edge auto-pan", () => {
    const hold = swiftNumber("GestureTranslator.swift", new RegExp(String.raw`drag\.minimumPressDuration = ${NUMBER}`));
    expect(gesture.TOUCH_DRAG_HOLD_MS).toBe(hold * 1_000);
    const translator = (name: string) => swiftNumber("GestureTranslator.swift", staticLet(name));
    expect(gesture.DRAG_EDGE_THRESHOLD).toBe(translator("dragEdgeThreshold"));
    expect(gesture.DRAG_EDGE_MINIMUM_SPEED).toBe(translator("dragEdgeMinimumSpeed"));
    expect(gesture.DRAG_EDGE_MAXIMUM_SPEED).toBe(translator("dragEdgeMaximumSpeed"));
  });

  it("cursor reconciliation", () => {
    expect(CURSOR_CONFIRMATION_TIMEOUT_MS).toBe(
      swiftNumber(
        "Config.swift",
        new RegExp(String.raw`AGENTDESK_CURSOR_CONFIRMATION_TIMEOUT_MS",\s+defaultValue: ${NUMBER}`),
      ),
    );
    expect(DEFAULT_PENDING_OPERATION_LIMIT).toBe(
      swiftNumber(
        "CursorReconciliationStateMachine.swift",
        new RegExp(String.raw`defaultPendingOperationLimit = ${NUMBER}`),
      ),
    );
    expect(CURSOR_MIRROR_RENDER_SCALE).toBe(swiftNumber("CursorPointerView.swift", staticLet("mirrorRenderScale")));
  });

  it("the scroll puck", () => {
    expect(POINTER_SCROLL_PUCK_SIDE).toBe(swiftNumber("PointerScrollPuck.swift", staticLet("side")));
    const offset = /pointerScrollPuckOffset\s+\?\? CGPoint\(x: (-?\d+), y: (-?\d+)\)/.exec(
      swift("PairingViewController+Layout.swift"),
    );
    expect(offset?.slice(1).map((value) => -Number(value))).toEqual([
      DEFAULT_POINTER_SCROLL_PUCK_OFFSET.right,
      DEFAULT_POINTER_SCROLL_PUCK_OFFSET.bottom,
    ]);
  });

  it("the trackpad and the scroll strip", () => {
    const layout = swift("PairingViewController+Layout.swift");
    expect(trackpad.SCROLL_STRIP_WIDTH).toBe(
      Number(/scrollStripView\.widthAnchor\.constraint\(equalToConstant: (\d+)\)/.exec(layout)?.[1]),
    );
    expect(trackpad.SCROLL_STRIP_RADIUS).toBe(Number(/scrollStripView\.layer\.cornerRadius = (\d+)/.exec(layout)?.[1]));
    const controller = swift("PairingViewController.swift");
    expect(trackpad.SCROLL_STRIP_HIT_OUTSET).toBe(
      Number(
        /let scrollStripView[\s\S]*?hitOutsets = UIEdgeInsets\(top: 0, left: 0, bottom: 0, right: (\d+)\)/.exec(
          controller,
        )?.[1],
      ),
    );
    expect(trackpad.TRACKPAD_HIT_OUTSET).toBe(
      Number(
        /let trackpadView[\s\S]*?hitOutsets = UIEdgeInsets\(top: 0, left: (\d+), bottom: 0, right: 0\)/.exec(
          controller,
        )?.[1],
      ),
    );
    expect(trackpad.TRACKPAD_STRIP_GAP).toBe(
      -Number(
        /trackpadView\.trailingAnchor\.constraint\(equalTo: scrollStripView\.leadingAnchor, constant: (-?\d+)\)/.exec(
          layout,
        )?.[1],
      ),
    );
  });
});
