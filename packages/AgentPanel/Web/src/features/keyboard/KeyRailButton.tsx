import type { ModifierState } from "@/features/keyboard/modifierLatch";

/**
 * One key on a key rail: a plain key, or a latching modifier that shows what it is holding.
 *
 * Shared by the two rails on this page so a Ctrl looks like a Ctrl whichever surface is being
 * typed into. Armed and locked are told apart on purpose -- armed is spent by the next key and
 * locked is not, and a rail that drew them the same would leave the user guessing which they had.
 */
export function KeyRailButton({
  label,
  state = "off",
  onClick,
  className = "text-xs",
}: {
  label: string;
  state?: ModifierState;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label === "⇧" ? "Shift modifier" : label}
      aria-pressed={state === "off" ? undefined : true}
      data-state={state}
      onClick={onClick}
      className={`min-h-0 min-w-0 cursor-pointer rounded border px-1 focus-visible:outline-2 focus-visible:outline-ring active:bg-accent ${className} ${
        state === "locked"
          ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
          : state === "armed"
            ? "border-primary bg-accent text-accent-foreground hover:bg-muted"
            : "border-border bg-muted text-foreground hover:bg-accent"
      }`}
    >
      {label}
    </button>
  );
}
