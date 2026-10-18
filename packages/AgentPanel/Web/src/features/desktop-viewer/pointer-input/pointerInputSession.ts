// One viewer's pointer input: the cursor model and the gesture translator that drives it.
//
// Made once per viewer and handed to every surface that sends pointer input, so the picture, the
// trackpad and the scroll strip share one cursor, one scroll phase, one coast and one held
// button. Two translators would let a strip touch miss the coast a puck flick started, and a
// trackpad move slip past a drag the picture was holding.

import { useState } from "react";
import type { DesktopPointerInput } from "@agentdesk/agent-feed-wire";
import { GestureTranslator, type FrameScheduler } from "@/features/desktop-viewer/pointer-input/gestureTranslator";
import { currentGestureTuning } from "@/features/desktop-viewer/pointer-input/gestureTuning";
import { RemoteCursor } from "@/features/desktop-viewer/pointer-input/remoteCursor";
import { useUnmountEffect } from "@/hooks/useMountEffect";
import { useNotify } from "@/hooks/useNotify";

export interface PointerInputSession {
  cursor: RemoteCursor;
  translator: GestureTranslator;
  /** Sends one input as it is, for what is neither a gesture nor a cursor move (a mouse button). */
  send: (input: DesktopPointerInput) => boolean;
  /** Points the session at the transport currently granted, or at nothing. */
  setSend: (send: ((input: DesktopPointerInput) => boolean) | undefined) => void;
  dispose: () => void;
}

const animationFrames: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

export function createPointerInputSession(
  send?: (input: DesktopPointerInput) => boolean,
  frames: FrameScheduler = animationFrames,
  now: () => number = () => performance.now(),
): PointerInputSession {
  let transport = send;
  const deliver = (input: DesktopPointerInput) => transport?.(input) ?? false;
  const cursor = new RemoteCursor({ send: deliver, now });
  const translator = new GestureTranslator({
    emit: (output) => (output.type === "cursor-move" ? cursor.move(output.dx, output.dy) : deliver(output)),
    frames,
    now,
    tuning: currentGestureTuning,
  });
  return {
    cursor,
    translator,
    send: deliver,
    setSend: (next) => {
      transport = next;
    },
    dispose: () => {
      // Lets go of anything held and closes any open phase while the transport is still there.
      translator.dispose();
      cursor.dispose();
    },
  };
}

/**
 * The session a surface should drive: the one it was handed, or one of its own.
 *
 * A viewer that has a trackpad hands one session to the picture and the deck. A picture on its
 * own (the park modal, a test) makes its own, and then also owns pointing it at the transport.
 */
export function usePointerInputSession(
  send: ((input: DesktopPointerInput) => boolean) | undefined,
  provided?: PointerInputSession,
): PointerInputSession {
  // Made whether or not one is handed in: it holds nothing until a gesture starts, and a surface
  // that is handed one on some renders and not others still has its own to fall back on.
  const [owned] = useState(() => createPointerInputSession(send));
  const session = provided ?? owned;
  // The session this owns sends through the latest `send`.
  useNotify(send, (next) => {
    if (!provided) session.setSend(next);
  });
  useUnmountEffect(() => owned.dispose());
  return session;
}
