import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  DELETE_REPEAT_DELAY_MS,
  DELETE_REPEAT_INTERVAL_MS,
  INITIAL_DECK_STATE,
  SHIFT_DOUBLE_TAP_MS,
  SPACE_CURSOR_STEP_PX,
  deckKeyId,
  deckKeyLabel,
  deckKeyName,
  deckRows,
  handleDeckKey,
  handleShiftTap,
  isSpecialKey,
  keyWidthWeight,
  type DeckKey,
  type KeyboardDeckState,
} from "./keyboardDeckModel";
import {
  CHARACTER_PREVIEW,
  characterPreviewLayout,
  characterPreviewPath,
  type CharacterPreviewLayout,
  type KeyboardDeckMetrics,
} from "./keyboardDeckMetrics";

/**
 * Resting and pressed fills, from `KeyboardKeyAppearance.swift`. The pairs invert by theme: a
 * light key darkens under the finger, a dark key lightens. Getting that backwards is the single
 * most visible way to look almost-but-not-like the iPhone keyboard.
 */
const REGULAR_FILL = "bg-white data-[pressed=true]:bg-[#d1d1d1] "
  + "dark:bg-[#737373] dark:data-[pressed=true]:bg-[#949494]";
const SPECIAL_FILL = "bg-[#bababa] data-[pressed=true]:bg-[#9e9e9e] "
  + "dark:bg-[#474747] dark:data-[pressed=true]:bg-[#666666]";
/** Pressed shadows are the resting ones at 0.35 opacity, shallower and tighter. */
const REGULAR_SHADOW = "shadow-[0_1.5px_0.75px_rgba(0,0,0,0.28)] "
  + "data-[pressed=true]:shadow-[0_0.5px_0.25px_rgba(0,0,0,0.098)] "
  + "dark:shadow-[0_1.5px_0.75px_rgba(0,0,0,0.62)] "
  + "dark:data-[pressed=true]:shadow-[0_0.5px_0.25px_rgba(0,0,0,0.217)]";
const SPECIAL_SHADOW = "shadow-[0_1.5px_0.75px_rgba(0,0,0,0.30)] "
  + "data-[pressed=true]:shadow-[0_0.5px_0.25px_rgba(0,0,0,0.105)] "
  + "dark:shadow-[0_1.5px_0.75px_rgba(0,0,0,0.68)] "
  + "dark:data-[pressed=true]:shadow-[0_0.5px_0.25px_rgba(0,0,0,0.238)]";

function titleSize(key: DeckKey): number {
  switch (key.kind) {
    case "return":
      return 24;
    case "page":
      return 18;
    case "space":
      return 16;
    default:
      return 22;
  }
}

interface ActivePress {
  pointerId: number;
  key: DeckKey;
  element: HTMLElement;
  /** Space-bar panning: where the finger landed and how many caret steps it has spent. */
  startX: number;
  lastStep: number;
  panned: boolean;
  cancelled: boolean;
}

export function KeyboardDeck({
  metrics,
  onCharacter,
  onDelete,
  onCursorDelta,
}: {
  metrics: KeyboardDeckMetrics;
  /** One typed character, including " " for space and "\n" for return. */
  onCharacter: (character: string) => void;
  onDelete: () => void;
  /** Positive moves the remote caret right. Emitted while panning across the space bar. */
  onCursorDelta: (delta: number) => void;
}) {
  const [state, setState] = useState<KeyboardDeckState>(INITIAL_DECK_STATE);
  const [pressedKeyId, setPressedKeyId] = useState<string | null>(null);
  const [preview, setPreview] = useState<
    { character: string; layout: CharacterPreviewLayout } | null
  >(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const press = useRef<ActivePress | null>(null);
  const lastShiftTapAt = useRef(0);
  const repeatTimer = useRef<number | null>(null);

  const stopRepeat = useCallback(() => {
    if (repeatTimer.current !== null) {
      window.clearTimeout(repeatTimer.current);
      window.clearInterval(repeatTimer.current);
      repeatTimer.current = null;
    }
  }, []);

  useEffect(() => stopRepeat, [stopRepeat]);

  const endPress = useCallback(() => {
    const active = press.current;
    if (active?.element.hasPointerCapture?.(active.pointerId)) {
      active.element.releasePointerCapture(active.pointerId);
    }
    press.current = null;
    stopRepeat();
    setPressedKeyId(null);
    setPreview(null);
  }, [stopRepeat]);

  const showPreview = useCallback((key: DeckKey, element: HTMLElement) => {
    const deck = deckRef.current;
    if (!deck) return;
    const keyRect = element.getBoundingClientRect();
    const deckRect = deck.getBoundingClientRect();
    setPreview({
      character: deckKeyLabel(key, stateRef.current),
      layout: characterPreviewLayout(
        { left: keyRect.left - deckRect.left, top: keyRect.top - deckRect.top, width: keyRect.width },
        deckRect.width,
      ),
    });
  }, []);

  const commit = useCallback((key: DeckKey) => {
    if (key.kind === "shift") {
      const now = performance.now();
      const isDoubleTap = stateRef.current.shift === "on"
        && now - lastShiftTapAt.current <= SHIFT_DOUBLE_TAP_MS;
      const next = handleShiftTap(stateRef.current, isDoubleTap);
      lastShiftTapAt.current = next.shift === "on" ? now : 0;
      setState(next);
      return;
    }
    lastShiftTapAt.current = 0;
    // Delete already fired on press-down, so the first backspace and its repeats are one sequence.
    if (key.kind === "delete") return;
    const result = handleDeckKey(stateRef.current, key);
    setState(result.state);
    if (result.output !== null) onCharacter(result.output);
  }, [onCharacter]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>, key: DeckKey) => {
    // Nothing on this deck may take focus: a focused editable is what summons WebKit's keyboard
    // and its form-navigation strip, which is the whole reason the deck exists.
    event.preventDefault();
    if (press.current) return;
    const element = event.currentTarget;
    // Touch captures the pointer to the pressed element on its own; a mouse does not, and without
    // this a drag onto the next key would report its moves there, leaving this key uncancelled and
    // committing it on release. jsdom implements neither, hence the guard.
    element.setPointerCapture?.(event.pointerId);
    press.current = {
      pointerId: event.pointerId,
      key,
      element,
      startX: event.clientX,
      lastStep: 0,
      panned: false,
      cancelled: false,
    };
    setPressedKeyId(deckKeyId(key));
    if (key.kind === "character") showPreview(key, element);
    if (key.kind === "delete") {
      onDelete();
      repeatTimer.current = window.setTimeout(() => {
        repeatTimer.current = window.setInterval(() => {
          const active = press.current;
          if (!active || active.cancelled) return;
          onDelete();
        }, DELETE_REPEAT_INTERVAL_MS);
      }, DELETE_REPEAT_DELAY_MS);
    }
  }, [onDelete, showPreview]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = press.current;
    if (!active || active.pointerId !== event.pointerId || active.cancelled) return;
    if (active.key.kind === "space") {
      const step = Math.trunc((event.clientX - active.startX) / SPACE_CURSOR_STEP_PX);
      const delta = step - active.lastStep;
      if (delta !== 0) {
        active.panned = true;
        active.lastStep = step;
        onCursorDelta(delta);
      }
      return;
    }
    // Sliding off a key cancels it, the way a drag-exit does on iOS.
    const bounds = active.element.getBoundingClientRect();
    const inside = event.clientX >= bounds.left && event.clientX <= bounds.right
      && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    if (!inside) {
      active.cancelled = true;
      endPress();
    }
  }, [endPress, onCursorDelta]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = press.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (!active.cancelled && !active.panned) commit(active.key);
    endPress();
  }, [commit, endPress]);

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = press.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.cancelled = true;
    endPress();
  }, [endPress]);

  const rows = deckRows(state);
  const deckStyle = {
    paddingTop: metrics.topDeckPadding,
    paddingBottom: metrics.bottomDeckPadding,
    paddingLeft: metrics.horizontalDeckInset,
    paddingRight: metrics.horizontalDeckInset,
    // The alphabet home row is centred at the top row's key width rather than stretched, which is
    // what produces the iPhone's half-key indent under Q and P.
    "--kbd-key-w": `calc((100% - ${9 * metrics.horizontalKeyGap}px) / 10)`,
  } as CSSProperties;

  return (
    <div
      ref={deckRef}
      role="group"
      aria-label="On-screen keyboard"
      data-testid="keyboard-deck"
      style={deckStyle}
      className="relative touch-none select-none bg-[#d1d4d9] dark:bg-[#1c1c1e]"
    >
      <div className="flex flex-col" style={{ gap: metrics.verticalRowGap }}>
        {rows.map((keys, rowIndex) => {
          const centred = rowIndex === 1 && state.page === "alphabet";
          const widensOuterGaps = rowIndex === 2 && state.page === "alphabet";
          const outerGap = metrics.alphabetOuterKeyGap - metrics.horizontalKeyGap;
          return (
            <div
              key={rowIndex}
              className={`flex ${centred ? "justify-center" : ""}`}
              style={{ height: metrics.keycapHeight, gap: metrics.horizontalKeyGap }}
            >
              {keys.map((key, keyIndex) => {
                const special = isSpecialKey(key);
                const widened = widensOuterGaps
                  && (keyIndex === 1 || keyIndex === keys.length - 1);
                const id = deckKeyId(key);
                return (
                  <button
                    key={id}
                    type="button"
                    data-testid={`deck-key-${id}`}
                    data-pressed={pressedKeyId === id}
                    aria-label={deckKeyName(key)}
                    aria-pressed={key.kind === "shift" ? state.shift !== "off" : undefined}
                    onPointerDown={(event) => onPointerDown(event, key)}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerCancel}
                    onContextMenu={(event) => event.preventDefault()}
                    style={{
                      fontSize: titleSize(key),
                      marginLeft: widened ? outerGap : undefined,
                      ...(centred
                        ? { width: "var(--kbd-key-w)", flex: "none" }
                        : { flexGrow: keyWidthWeight(key), flexBasis: 0, minWidth: 0 }),
                    }}
                    // `touch-action` does not inherit, so the deck's own value does not reach the
                    // keys: without this a press that drifts scrolls the page instead of typing.
                    className={`touch-none rounded-lg leading-none text-black transition-none dark:text-white
                      data-[pressed=true]:translate-y-px
                      focus-visible:outline-2 focus-visible:outline-ring
                      ${special ? SPECIAL_FILL : REGULAR_FILL}
                      ${special ? SPECIAL_SHADOW : REGULAR_SHADOW}
                      ${key.kind === "shift" && state.shift !== "off"
                        ? "ring-2 ring-black/40 dark:ring-white/50"
                        : ""}`}
                  >
                    {deckKeyLabel(key, state)}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {preview ? (
        <div
          aria-hidden
          data-testid="deck-key-preview"
          className="pointer-events-none absolute"
          style={{
            left: preview.layout.left,
            top: preview.layout.top,
            width: preview.layout.width,
            height: preview.layout.height,
          }}
        >
          <svg
            width={preview.layout.width}
            height={preview.layout.height}
            viewBox={`0 0 ${preview.layout.width} ${preview.layout.height}`}
            className="absolute inset-0 drop-shadow-[0_2px_2px_rgba(0,0,0,0.30)] dark:drop-shadow-[0_2px_2px_rgba(0,0,0,0.72)]"
          >
            <path
              d={characterPreviewPath(preview.layout.width, preview.layout.height, preview.layout.tipX)}
              className="fill-white dark:fill-[#8c8c8c]"
            />
          </svg>
          <span
            className="absolute inset-x-0 text-center text-black dark:text-white"
            style={{
              top: 2,
              fontSize: 34,
              lineHeight: `${CHARACTER_PREVIEW.bubbleHeight - 4}px`,
            }}
          >
            {preview.character}
          </span>
        </div>
      ) : null}
    </div>
  );
}
