import type { RemoteKeyCode, RemoteModifier } from "@agentdesk/agent-feed-wire";
import type { RefObject, TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import type { ModifierState } from "./desktopKeyboardModel";

const ARROWS: Array<{ label: string; code: RemoteKeyCode; position: string }> = [
  { label: "↑", code: "up", position: "col-start-2 row-start-1" },
  { label: "←", code: "left", position: "col-start-1 row-start-2" },
  { label: "↓", code: "down", position: "col-start-2 row-start-2" },
  { label: "→", code: "right", position: "col-start-3 row-start-2" },
];
const MODIFIERS: Array<{ label: string; modifier: RemoteModifier }> = [
  { label: "Cmd", modifier: "cmd" },
  { label: "Ctrl", modifier: "ctrl" },
  { label: "Opt", modifier: "option" },
];

export function DesktopKeyboardChrome({
  captureRef,
  accessoryRef,
  captureProps,
  shown,
  available,
  autoKeyboard,
  modifiers,
  receipt,
  localEcho,
  deliveryStatus,
  bottom,
  softwareKeyboardVisible,
  onShow,
  onHide,
  onAutoChange,
  onKey,
  onModifier,
  onPasteToMac,
}: {
  captureRef: RefObject<HTMLTextAreaElement | null>;
  /** Measured by the keyboard hook so the viewer can end the video above this bar. */
  accessoryRef: RefObject<HTMLElement | null>;
  captureProps: TextareaHTMLAttributes<HTMLTextAreaElement>;
  shown: boolean;
  available: boolean;
  autoKeyboard: boolean;
  modifiers: Record<RemoteModifier, ModifierState>;
  receipt: string[];
  localEcho: string[];
  deliveryStatus: string | null;
  bottom: number;
  softwareKeyboardVisible: boolean;
  onShow: () => void;
  onHide: () => void;
  onAutoChange: (enabled: boolean) => void;
  onKey: (code: RemoteKeyCode) => void;
  onModifier: (modifier: RemoteModifier) => void;
  /** Reads the clipboard and sends it, without any field on this page taking focus. */
  onPasteToMac: () => void;
}) {
  const deliveryPending = deliveryStatus === "Delivering…" || deliveryStatus === "Waiting for focus…";
  const deliveryProblem = deliveryStatus !== null && deliveryStatus !== "Delivered" && !deliveryPending;
  return (
    <>
      {createPortal(<textarea
        ref={captureRef}
        aria-label="Remote Mac keyboard input"
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        {...captureProps}
        tabIndex={-1}
        // A 4x4 nothing in the corner, focused programmatically to raise the keyboard and never
        // touched directly. It stays that way on purpose: WebKit draws its form-navigation strip
        // over the panel's own key rail for any field big enough to tap, and in a browser tab
        // nothing can remove that strip. Pasting goes through the Paste button instead, which
        // needs no focused field at all.
        style={{ bottom: `${bottom + 8}px`, fontSize: 16 }}
        className="fixed left-2 h-4 w-4 opacity-0 pointer-events-none"
      />, document.body)}

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
      ) : createPortal(
        <section
          ref={accessoryRef}
          aria-label="Remote keyboard controls"
          style={{
            bottom: `${bottom}px`,
            paddingBottom: softwareKeyboardVisible ? 4 : "max(4px, env(safe-area-inset-bottom))",
          }}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          className="pointer-events-auto fixed inset-x-0 z-50 border-t border-border bg-background px-1.5 pt-1 text-foreground"
        >
          <div className="mb-1 flex h-8 items-center gap-1 rounded-lg border border-border bg-muted px-2">
            <output
              aria-label="Local typing echo"
              className={`flex min-w-0 flex-1 select-none justify-end overflow-hidden text-sm ${localEcho.length ? "text-foreground" : "text-muted-foreground"}`}
            >
              <span className="min-w-full shrink-0 whitespace-pre">
                {localEcho.length > 0 ? localEcho.join("") : "Type to send to Mac"}
              </span>
            </output>
            <span
              role="status"
              aria-label="Input delivery"
              className={deliveryProblem
                ? "max-w-[35%] truncate text-[10px] text-destructive"
                : "sr-only"}
            >
              {deliveryStatus ?? "Ready"}
            </span>
            {deliveryPending ? <span aria-hidden className="text-xs text-muted-foreground">…</span> : null}
            <button
              type="button"
              onClick={onPasteToMac}
              className="h-7 shrink-0 cursor-pointer rounded px-1.5 text-[10px] text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring active:bg-accent"
            >
              Paste
            </button>
            <button
              type="button"
              aria-label="Auto keyboard"
              aria-pressed={autoKeyboard}
              onClick={() => onAutoChange(!autoKeyboard)}
              className={`h-7 shrink-0 cursor-pointer rounded px-1.5 text-[10px] hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring active:bg-accent ${autoKeyboard ? "text-foreground" : "text-muted-foreground"}`}
            >
              Auto
            </button>
            <button
              type="button"
              onClick={onHide}
              className="h-7 shrink-0 cursor-pointer rounded px-1.5 text-[10px] text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring active:bg-accent"
            >
              Hide
            </button>
          </div>
          <output aria-label="Acknowledged remote input" className="sr-only">
            {receipt.join("")}
          </output>
          <div aria-label="Remote key rail" className="grid h-9 grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,2fr)_repeat(3,minmax(0,1fr))] gap-1">
            <KeyboardButton label="Esc" onClick={() => onKey("escape")} />
            <KeyboardButton label="Tab" onClick={() => onKey("tab")} />
            <KeyboardButton label="⇧" state={modifiers.shift} onClick={() => onModifier("shift")} />
            <div role="group" aria-label="Arrow keys" className="grid h-full grid-cols-3 grid-rows-2 gap-0.5">
              {ARROWS.map((key) => (
                <KeyboardButton key={key.code} label={key.label} className={`${key.position} text-base leading-none`} onClick={() => onKey(key.code)} />
              ))}
            </div>
            {MODIFIERS.map(({ label, modifier }) => (
              <KeyboardButton
                key={modifier}
                label={label}
                state={modifiers[modifier]}
                onClick={() => onModifier(modifier)}
              />
            ))}
          </div>
        </section>, document.body,
      )}
    </>
  );
}

function KeyboardButton({
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
      aria-label={label === "⇧" ? "Shift" : label}
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
