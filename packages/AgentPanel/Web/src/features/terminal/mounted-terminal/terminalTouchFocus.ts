// Focusing the terminal from a tap, so a phone gets a keyboard.
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

import { TAP_SLOP_PX } from "@/features/terminal/mounted-terminal/agentTerminalLayout";

/** Binds tap-to-focus on the mount; the answer unbinds it. A drag is not a tap. */
export function bindTouchFocus(mount: HTMLDivElement, focus: () => void): () => void {
  // Only a tap, never a drag: a finger scrolling back over output has not asked to type, and
  // a keyboard thrown up mid-scroll takes half the screen the reader was using.
  let touchOrigin: { x: number; y: number } | null = null;
  const noteTouchStart = (event: TouchEvent): void => {
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    touchOrigin = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const focusOnTap = (event: TouchEvent): void => {
    const origin = touchOrigin;
    touchOrigin = null;
    const touch = event.changedTouches[0];
    if (!origin || !touch) return;
    const moved = Math.abs(touch.clientX - origin.x) > TAP_SLOP_PX || Math.abs(touch.clientY - origin.y) > TAP_SLOP_PX;
    if (moved) return;
    focus();
  };
  mount.addEventListener("touchstart", noteTouchStart, { passive: true });
  mount.addEventListener("touchend", focusOnTap);
  return () => {
    mount.removeEventListener("touchstart", noteTouchStart);
    mount.removeEventListener("touchend", focusOnTap);
  };
}
