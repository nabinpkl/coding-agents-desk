/**
 * A modifier key you press instead of hold.
 *
 * A finger cannot hold Ctrl and reach a letter at the same time, so every touch keyboard latches:
 * one tap arms the modifier for the next key, a second locks it until it is tapped off. Shared,
 * because both key rails on this page -- the desktop viewer's, which sends the Mac a modified key
 * event, and the terminal's, which sends a PTY a control byte -- have to feel the same under the
 * same finger even though nothing else about them is alike.
 */
export type ModifierState = "off" | "armed" | "locked";

/** Off, armed for one key, locked, and back. The order a phone's shift key taught everyone. */
export function cycleModifier(state: ModifierState): ModifierState {
  return state === "off" ? "armed" : state === "armed" ? "locked" : "off";
}

/** After a key has been sent: an armed modifier has been spent, a locked one stays. */
export function releaseArmed<Key extends string>(
  states: Record<Key, ModifierState>,
): Record<Key, ModifierState> {
  const released = { ...states };
  for (const key of Object.keys(released) as Key[]) {
    if (released[key] === "armed") released[key] = "off";
  }
  return released;
}
