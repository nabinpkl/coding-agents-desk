import type { RemoteKeyCode, RemoteModifier } from "@agentdesk/agent-feed-wire";
import type { RefObject, TextareaHTMLAttributes } from "react";
import type { ModifierState } from "./desktopKeyboardModel";

const KEYS: Array<{ label: string; code: RemoteKeyCode }> = [
  { label: "Esc", code: "escape" },
  { label: "Tab", code: "tab" },
  { label: "←", code: "left" },
  { label: "↓", code: "down" },
  { label: "↑", code: "up" },
  { label: "→", code: "right" },
];
const MODIFIERS: Array<{ label: string; modifier: RemoteModifier }> = [
  { label: "Cmd", modifier: "cmd" },
  { label: "Ctrl", modifier: "ctrl" },
  { label: "Opt", modifier: "option" },
  { label: "⇧", modifier: "shift" },
];

export function DesktopKeyboardChrome({
  captureRef,
  captureProps,
  shown,
  available,
  autoKeyboard,
  modifiers,
  receipt,
  deliveryStatus,
  bottom,
  onShow,
  onHide,
  onAutoChange,
  onKey,
  onModifier,
}: {
  captureRef: RefObject<HTMLTextAreaElement | null>;
  captureProps: TextareaHTMLAttributes<HTMLTextAreaElement>;
  shown: boolean;
  available: boolean;
  autoKeyboard: boolean;
  modifiers: Record<RemoteModifier, ModifierState>;
  receipt: string[];
  deliveryStatus: string | null;
  bottom: number;
  onShow: () => void;
  onHide: () => void;
  onAutoChange: (enabled: boolean) => void;
  onKey: (code: RemoteKeyCode) => void;
  onModifier: (modifier: RemoteModifier) => void;
}) {
  return (
    <>
      <textarea
        ref={captureRef}
        aria-label="Remote Mac keyboard input"
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        {...captureProps}
        className="fixed left-0 top-0 h-4 w-4 opacity-0 pointer-events-none"
      />

      {!shown ? (
        <div className="pointer-events-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-white/75">
            <input
              type="checkbox"
              checked={autoKeyboard}
              onChange={(event) => onAutoChange(event.currentTarget.checked)}
              className="accent-white"
            />
            Auto
          </label>
          <button
            type="button"
            disabled={!available}
            onClick={onShow}
            className="rounded-md bg-white px-2.5 py-1.5 text-[11px] text-black disabled:opacity-40"
          >
            Keyboard
          </button>
        </div>
      ) : (
        <section
          aria-label="Remote keyboard controls"
          style={{ bottom: `${bottom}px` }}
          className="fixed inset-x-0 z-40 border-t border-white/15 bg-zinc-950/95 px-2 pb-[max(0.4rem,env(safe-area-inset-bottom))] pt-2 text-white shadow-2xl backdrop-blur"
        >
          <div className="mb-2 flex min-h-8 items-center gap-2 rounded-md bg-white/8 px-2">
            <output
              aria-label="Acknowledged remote input"
              className="min-w-0 flex-1 select-none truncate font-mono text-xs text-white/90"
            >
              {receipt.length > 0 ? receipt.join("") : "Type to send to Mac"}
            </output>
            <span className="shrink-0 font-mono text-[10px] text-white/55">
              {deliveryStatus ?? "Ready"}
            </span>
          </div>
          <div className="flex gap-1 overflow-x-auto pb-1" onPointerDown={(event) => event.preventDefault()}>
            {KEYS.map((key) => (
              <KeyboardButton key={key.code} label={key.label} onClick={() => onKey(key.code)} />
            ))}
            {MODIFIERS.map(({ label, modifier }) => (
              <KeyboardButton
                key={modifier}
                label={label}
                state={modifiers[modifier]}
                onClick={() => onModifier(modifier)}
              />
            ))}
            <button
              type="button"
              aria-pressed={autoKeyboard}
              onClick={() => onAutoChange(!autoKeyboard)}
              className="min-w-16 shrink-0 rounded-md border border-white/15 bg-white/8 px-2 py-2 text-xs text-white focus-visible:outline-2 focus-visible:outline-blue-400 active:scale-95"
            >
              Auto {autoKeyboard ? "On" : "Off"}
            </button>
            <KeyboardButton label="Hide" onClick={onHide} />
          </div>
        </section>
      )}
    </>
  );
}

function KeyboardButton({
  label,
  state = "off",
  onClick,
}: {
  label: string;
  state?: ModifierState;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={state === "off" ? undefined : state === "locked"}
      data-state={state}
      onClick={onClick}
      className={`min-w-12 shrink-0 rounded-md border px-2 py-2 text-xs focus-visible:outline-2 focus-visible:outline-blue-400 active:scale-95 ${
        state === "locked"
          ? "border-blue-300 bg-blue-500 text-white"
          : state === "armed"
            ? "border-blue-400/70 bg-blue-500/25 text-blue-100"
            : "border-white/15 bg-white/8 text-white"
      }`}
    >
      {label}
    </button>
  );
}
