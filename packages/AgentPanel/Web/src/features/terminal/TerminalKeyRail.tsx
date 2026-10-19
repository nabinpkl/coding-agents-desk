import { KeyRailButton } from "@/features/keyboard/KeyRailButton";
import type { ModifierState } from "@/features/keyboard/modifierLatch";
import type { RailKey, RailModifier } from "@agentdesk/agent-feed-wire";

const ARROWS: Array<{ label: string; key: RailKey; position: string }> = [
  { label: "↑", key: "up", position: "col-start-2 row-start-1" },
  { label: "←", key: "left", position: "col-start-1 row-start-2" },
  { label: "↓", key: "down", position: "col-start-2 row-start-2" },
  { label: "→", key: "right", position: "col-start-3 row-start-2" },
];
const MODIFIERS: Array<{ label: string; modifier: RailModifier }> = [
  { label: "Ctrl", modifier: "ctrl" },
  // "Alt" rather than the Mac's "Opt": in a terminal this is Meta, and what it does is prefix an
  // escape -- Alt is the name every program on the far end knows it by.
  { label: "Alt", modifier: "alt" },
];

/**
 * The keys a phone keyboard does not have, for the terminal it sits under.
 *
 * Esc, Tab, the arrows and Ctrl are most of how a terminal is driven and none of them are on an
 * iOS keyboard, so a phone can raise the keyboard, type prose into a shell, and still be unable to
 * interrupt it. The rail is that missing half.
 *
 * Deliberately NOT the desktop viewer's rail with a different sink behind it: that one sends the
 * Mac a key event through a capture field, and this one sends a PTY bytes. What the two genuinely
 * share -- how a latching modifier behaves, and what a key looks like -- is shared as code
 * (`features/keyboard`), and the rest is different because the machines are.
 *
 * `layout="bar"` is the same keys in the same arrangement, for the keyboard bar
 * (`features/keyboard/KeyboardBar.tsx`) that stands on the phone's keyboard: the bar gives it its
 * edges and its height, so the rail drops its own border and fills the bar.
 */
export function TerminalKeyRail({
  modifiers,
  onModifier,
  onKey,
  layout = "rail",
}: {
  modifiers: Record<RailModifier, ModifierState>;
  onModifier: (modifier: RailModifier) => void;
  onKey: (key: RailKey) => void;
  layout?: "rail" | "bar";
}) {
  const onBar = layout === "bar";
  const keyText = onBar ? "text-sm" : "text-xs";
  return (
    <section
      aria-label="Terminal key rail"
      // A press here must never take focus: the terminal losing it would take the keyboard down
      // with it, which is the one thing this row exists to work alongside.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      // As tall as its keys rather than a fixed height: the arrow pad's two rows need 38px, and a
      // 36px rail let them hang over the footer below. Taking the room pushes the screen up instead.
      className={`grid grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,2fr)_repeat(2,minmax(0,1fr))] gap-1 ${
        onBar ? "h-full min-w-0 flex-1" : "shrink-0 border-t border-border px-1.5 py-1"
      }`}
    >
      <KeyRailButton label="Esc" className={keyText} onClick={() => onKey("escape")} />
      <KeyRailButton label="Tab" className={keyText} onClick={() => onKey("tab")} />
      <KeyRailButton label="⇧" className={keyText} state={modifiers.shift} onClick={() => onModifier("shift")} />
      <div role="group" aria-label="Arrow keys" className="grid h-full grid-cols-3 grid-rows-2 gap-0.5">
        {ARROWS.map((arrow) => (
          <KeyRailButton
            key={arrow.key}
            label={arrow.label}
            className={`${arrow.position} text-base leading-none`}
            onClick={() => onKey(arrow.key)}
          />
        ))}
      </div>
      {MODIFIERS.map(({ label, modifier }) => (
        <KeyRailButton
          key={modifier}
          label={label}
          className={keyText}
          state={modifiers[modifier]}
          onClick={() => onModifier(modifier)}
        />
      ))}
    </section>
  );
}
