import type { RemoteKeyCode, RemoteModifier } from "@agentdesk/agent-feed-wire";
import { useState, type RefObject, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import type { ModifierState } from "@/features/desktop-viewer/keyboard-input/desktopKeyboardModel";
import { KeyRailButton as KeyboardButton } from "@/features/keyboard/KeyRailButton";
import { KeyboardDeck } from "@/features/desktop-viewer/keyboard-deck/KeyboardDeck";
import { deckMetricsForViewportHeight } from "@/features/desktop-viewer/keyboard-deck/keyboardDeckMetrics";
import { useEventListener } from "@/hooks/dom/useEventListener";

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
  onDeckCharacter,
  onDeckCursorDelta,
  onDeckBackspace,
  draft,
  onSendDraft,
  onCancelDraft,
  showsDeck,
  deckAvailable,
  onKeyboardMode,
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
  /** One character typed on the deck, including " " for space and "\n" for return. */
  onDeckCharacter: (character: string) => void;
  onDeckCursorDelta: (delta: number) => void;
  onDeckBackspace: () => void;
  /** Pasted text being edited before it goes, or null when there is no paste in hand. */
  draft: string | null;
  onSendDraft: () => void;
  onCancelDraft: () => void;
  /** Whether the panel's own keyboard is the one typing. */
  showsDeck: boolean;
  /** Whether a deck is on offer here at all; false on a browser with a physical keyboard. */
  deckAvailable: boolean;
  onKeyboardMode: (mode: "deck" | "native") => void;
}) {
  const deckMetrics = useDeckMetrics();
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
        // Auto keyboard is set from the viewer's settings popover while this is down, and from
        // the accessory's own Auto button while it is up.
        <button
          type="button"
          disabled={!available}
          onClick={onShow}
          className="pointer-events-auto shrink-0 rounded-md bg-white px-2.5 py-1.5 text-[11px] text-black transition-colors
            hover:bg-white/90 active:bg-white/80 focus-visible:outline-2 focus-visible:outline-offset-2
            focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
        >
          Keyboard
        </button>
      ) : createPortal(
        <section
          ref={accessoryRef}
          aria-label="Remote keyboard controls"
          style={{ bottom: `${bottom}px` }}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          // No padding of its own: the deck below spans this edge to edge so its outermost keys
          // own the screen's edge, and the strip and rail carry their own inset instead.
          className="pointer-events-auto fixed inset-x-0 z-50 border-t border-border bg-background pt-1 text-foreground"
        >
          <div
            className="px-1.5"
            style={showsDeck ? undefined : {
              paddingBottom: softwareKeyboardVisible ? 4 : "max(4px, env(safe-area-inset-bottom))",
            }}
          >
            <div className={`mb-1 flex items-center gap-1 rounded-lg border bg-muted px-2 ${
              draft === null ? "h-8 border-border" : "min-h-8 border-primary py-1"}`}>
              {draft === null ? (
                <output
                  aria-label="Local typing echo"
                  className={`flex min-w-0 flex-1 select-none justify-end overflow-hidden text-sm ${localEcho.length ? "text-foreground" : "text-muted-foreground"}`}
                >
                  <span className="min-w-full shrink-0 whitespace-pre">
                    {localEcho.length > 0 ? localEcho.join("") : "Type to send to Mac"}
                  </span>
                </output>
              ) : (
                /*
                 * A field in everything but kind: it shows the text, carries a caret, and the deck
                 * edits it. What it must never be is focusable, because a focused editable is what
                 * summons WebKit's keyboard and the form strip the deck exists to avoid.
                 */
                <div
                  role="textbox"
                  aria-readonly
                  aria-label="Pasted text, editable before sending"
                  className="max-h-20 min-w-0 flex-1 select-none overflow-y-auto whitespace-pre-wrap break-words text-left text-sm text-foreground"
                >
                  {draft}
                  <span aria-hidden className="ml-px inline-block w-px animate-pulse self-stretch bg-foreground align-middle" style={{ height: "1.1em" }} />
                </div>
              )}
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
              {deckAvailable && !showsDeck ? (
                <button
                  type="button"
                  aria-label="Switch to the panel keyboard"
                  onClick={() => onKeyboardMode("deck")}
                  className="h-7 shrink-0 cursor-pointer rounded px-1.5 text-[10px] text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring active:bg-accent"
                >
                  Panel
                </button>
              ) : null}
              {draft === null ? (
                <button
                  type="button"
                  onClick={onPasteToMac}
                  className="h-7 shrink-0 cursor-pointer rounded px-1.5 text-[10px] text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring active:bg-accent"
                >
                  Paste
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onCancelDraft}
                    className="h-7 shrink-0 cursor-pointer rounded px-1.5 text-[10px] text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring active:bg-accent"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={onSendDraft}
                    className="h-7 shrink-0 cursor-pointer rounded bg-primary px-2 text-[10px] text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    Send
                  </button>
                </>
              )}
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
          </div>
          {showsDeck ? (
            <KeyboardDeck
              metrics={deckMetrics}
              edgeInset={{
                x: 6,
                bottom: softwareKeyboardVisible ? "4px" : "max(4px, env(safe-area-inset-bottom))",
              }}
              onCharacter={onDeckCharacter}
              onDelete={onDeckBackspace}
              onCursorDelta={onDeckCursorDelta}
              onSwitchToNative={() => onKeyboardMode("native")}
            />
          ) : null}
        </section>, document.body,
      )}
    </>
  );
}

/** iOS swaps its metrics on the vertical size class; a page has only the viewport's height. */
function useDeckMetrics() {
  const [metrics, setMetrics] = useState(() =>
    deckMetricsForViewportHeight(window.visualViewport?.height ?? window.innerHeight));
  const update = () => setMetrics(
    deckMetricsForViewportHeight(window.visualViewport?.height ?? window.innerHeight));
  useEventListener(window, "resize", update);
  useEventListener(window.visualViewport, "resize", update);
  return metrics;
}
