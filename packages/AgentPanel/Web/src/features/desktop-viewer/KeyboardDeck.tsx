import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  DELETE_REPEAT_DELAY_MS,
  DELETE_REPEAT_INTERVAL_MS,
  INITIAL_DECK_STATE,
  SHIFT_DOUBLE_TAP_MS,
  SPACE_CURSOR_STEP_PX,
  SPACE_PAN_SLOP_PX,
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
  keyExitSlop,
  type CharacterPreviewLayout,
  type KeyboardDeckMetrics,
} from "./keyboardDeckMetrics";
import {
  cellAtPoint,
  deckHitCells,
  pointHoldsCell,
  type DeckCell,
} from "./keyboardDeckHitTest";

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
/**
 * An armed or locked shift washes the keycap in the tint colour rather than taking either special
 * fill, which is `isActiveSpecial` in `KeyboardKeyButton.applyVisualState`. The alpha is the whole
 * effect: the deck shows through, so the key reads as lit rather than as a different key.
 */
const ACTIVE_FILL = "bg-[rgba(0,122,255,0.42)] data-[pressed=true]:bg-[rgba(0,122,255,0.62)]";
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
  /** The tiled area this press owns, in deck coordinates. Read once; layout cannot move mid-press. */
  cell: DeckCell;
  deckOrigin: { left: number; top: number };
  /** Where the finger landed, against which the space bar measures its slop. */
  startX: number;
  /**
   * Where the space-bar pan was recognised, or null while it is still inside the slop. iOS spends
   * a pan recogniser's slop before `.began`, and counts caret steps from there rather than from
   * touch-down, so a tap that drifts a little still types a space.
   */
  panOriginX: number | null;
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
  const [pressedKeyIds, setPressedKeyIds] = useState<readonly string[]>([]);
  // Owned by the pointer that raised it: rolling a second thumb onto another key takes the balloon
  // over, and lifting the first thumb must not take the second one's balloon away with it.
  const [preview, setPreview] = useState<
    { pointerId: number; character: string; layout: CharacterPreviewLayout } | null
  >(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** One entry per finger. Two-thumb typing is ordinary typing, and each key tracks its own touch. */
  const presses = useRef(new Map<number, ActivePress>());
  /** The rows as last rendered, so a resolved cell can be turned back into the key it stands for. */
  const rowsRef = useRef<DeckKey[][]>([]);
  const cellsRef = useRef<{
    cells: DeckCell[][];
    elements: HTMLElement[][];
    origin: { left: number; top: number };
  } | null>(null);
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

  // A layout change takes the balloon down, even from under a finger that is still holding its
  // key: `render(_:)` dismisses it whenever the state it is asked for differs from the one on
  // screen. Reachable with two thumbs, where one holds a letter while the other taps shift.
  useEffect(() => setPreview(null), [state]);

  // A different page or a different metric set is a different tiling.
  useEffect(() => {
    cellsRef.current = null;
  }, [state, metrics]);

  // And so is a resize, which changes no state at all.
  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;
    const observer = new ResizeObserver(() => {
      cellsRef.current = null;
    });
    observer.observe(deck);
    return () => observer.disconnect();
  }, []);

  const releasePress = useCallback((active: ActivePress) => {
    if (active.element.hasPointerCapture?.(active.pointerId)) {
      active.element.releasePointerCapture(active.pointerId);
    }
    presses.current.delete(active.pointerId);
    if (active.key.kind === "delete") stopRepeat();
    setPressedKeyIds([...presses.current.values()].map((held) => deckKeyId(held.key)));
    setPreview((current) => (current?.pointerId === active.pointerId ? null : current));
  }, [stopRepeat]);

  const showPreview = useCallback((press: ActivePress) => {
    const deck = deckRef.current;
    if (!deck) return;
    const keyRect = press.element.getBoundingClientRect();
    const deckRect = deck.getBoundingClientRect();
    setPreview({
      pointerId: press.pointerId,
      character: deckKeyLabel(press.key, stateRef.current),
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
    // Delete already fired on press-down, so the first backspace and its repeats are one sequence.
    // It leaves the double-tap window open too: on iOS a delete never reaches the key handler at
    // all, because the button returns at `touchUpInside` before it calls `onPress`.
    if (key.kind === "delete") return;
    lastShiftTapAt.current = 0;
    const result = handleDeckKey(stateRef.current, key);
    setState(result.state);
    if (result.output !== null) onCharacter(result.output);
  }, [onCharacter]);

  /**
   * The tiling, measured once and kept until the deck changes shape. Rebuilding it per move would
   * force a layout of the deck, its rows, and all thirty-one keys on every event.
   */
  const geometry = useCallback(() => {
    if (cellsRef.current) return cellsRef.current;
    const deck = deckRef.current;
    if (!deck) return null;
    const deckRect = deck.getBoundingClientRect();
    const rowElements = [...deck.querySelectorAll<HTMLElement>("[data-deck-row]")];
    const elements = rowElements.map((row) => [...row.children] as HTMLElement[]);
    const rows = rowElements.map((row, rowIndex) => {
      const bounds = row.getBoundingClientRect();
      return {
        top: bounds.top - deckRect.top,
        bottom: bounds.bottom - deckRect.top,
        keys: elements[rowIndex]!.map((child) => {
          const box = child.getBoundingClientRect();
          return { left: box.left - deckRect.left, right: box.right - deckRect.left };
        }),
      };
    });
    cellsRef.current = {
      cells: deckHitCells(rows, { width: deckRect.width, height: deckRect.height }),
      elements,
      origin: { left: deckRect.left, top: deckRect.top },
    };
    return cellsRef.current;
  }, []);

  /**
   * Resolve a touch to a key by the tiled cells rather than by whatever element is under it, so
   * the gaps, the deck's padding, and the home row's indent all belong to a key.
   */
  const resolve = useCallback((clientX: number, clientY: number) => {
    const built = geometry();
    if (!built) return null;
    const point = { x: clientX - built.origin.left, y: clientY - built.origin.top };
    const cell = cellAtPoint(built.cells, point);
    if (!cell) return null;
    const element = built.elements[cell.row]?.[cell.key];
    const key = rowsRef.current[cell.row]?.[cell.key];
    if (!element || !key) return null;
    return { cell, element, key, deckOrigin: built.origin };
  }, [geometry]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // Nothing on this deck may take focus: a focused editable is what summons WebKit's keyboard
    // and its form-navigation strip, which is the whole reason the deck exists.
    event.preventDefault();
    const hit = resolve(event.clientX, event.clientY);
    if (!hit) return;
    const key = hit.key;
    // A pointer id whose release never arrived would otherwise be poisoned for good, and iOS
    // reuses ids: one missed `pointerup` would silently swallow every later touch that got the
    // same id. Discard the stale press and take this one.
    const stale = presses.current.get(event.pointerId);
    if (stale) releasePress(stale);
    // Capture to the deck, not the keycap: the cells are the targets now, and a drag across them
    // has to keep reporting here. Touch captures implicitly; a mouse does not. jsdom has neither.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const active: ActivePress = {
      pointerId: event.pointerId,
      key,
      element: hit.element,
      cell: hit.cell,
      deckOrigin: hit.deckOrigin,
      startX: event.clientX,
      panOriginX: null,
      lastStep: 0,
      panned: false,
      cancelled: false,
    };
    presses.current.set(event.pointerId, active);
    setPressedKeyIds([...presses.current.values()].map((held) => deckKeyId(held.key)));
    if (key.kind === "character") showPreview(active);
    if (key.kind === "delete") {
      onDelete();
      // One repeat for the one delete key, restarted rather than stacked, as the Swift's scheduler
      // does by stopping inside `start`. Two fingers on it otherwise leave an orphaned timer.
      stopRepeat();
      repeatTimer.current = window.setTimeout(() => {
        repeatTimer.current = window.setInterval(() => {
          const held = presses.current.get(active.pointerId);
          if (!held || held.cancelled) return;
          onDelete();
        }, DELETE_REPEAT_INTERVAL_MS);
      }, DELETE_REPEAT_DELAY_MS);
    }
  }, [onDelete, releasePress, resolve, showPreview, stopRepeat]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const active = presses.current.get(event.pointerId);
    if (!active || active.cancelled) return;
    if (active.key.kind === "space") {
      if (active.panOriginX === null) {
        if (Math.abs(event.clientX - active.startX) < SPACE_PAN_SLOP_PX) return;
        active.panOriginX = event.clientX;
        return;
      }
      const step = Math.trunc((event.clientX - active.panOriginX) / SPACE_CURSOR_STEP_PX);
      const delta = step - active.lastStep;
      if (delta !== 0) {
        active.panned = true;
        active.lastStep = step;
        onCursorDelta(delta);
      }
      return;
    }
    // Delete is a hold, not a slide: it fired on press-down and repeats, so leaving its cell ends
    // it rather than handing the press to whatever is next door.
    if (active.key.kind === "delete") {
      const point = {
        x: event.clientX - active.deckOrigin.left,
        y: event.clientY - active.deckOrigin.top,
      };
      if (!pointHoldsCell(active.cell, point, keyExitSlop(metrics))) {
        active.cancelled = true;
        releasePress(active);
      }
      return;
    }
    // Every other key follows the finger. This is the stock iPhone behaviour and a deliberate
    // departure from the Swift keyboard, whose buttons abandon the touch on drag-exit: sliding
    // from one key to another types the one you land on, and the balloon moves with you.
    const hit = resolve(event.clientX, event.clientY);
    if (!hit) {
      // Off the deck entirely. Nothing under the finger to hand the press to.
      active.cancelled = true;
      releasePress(active);
      return;
    }
    if (hit.cell.row === active.cell.row && hit.cell.key === active.cell.key) return;
    active.cell = hit.cell;
    active.element = hit.element;
    active.key = hit.key;
    setPressedKeyIds([...presses.current.values()].map((held) => deckKeyId(held.key)));
    if (hit.key.kind === "character") {
      showPreview(active);
    } else {
      setPreview((current) => (current?.pointerId === active.pointerId ? null : current));
    }
  }, [metrics, onCursorDelta, releasePress, resolve, showPreview]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const active = presses.current.get(event.pointerId);
    if (!active) return;
    const commits = !active.cancelled && !active.panned;
    // Release before committing, as the Swift does, so the balloon is never the thing standing
    // over a key that has already typed. React batches both into one paint, so the order is a
    // statement of intent here rather than a frame the viewer could otherwise catch.
    releasePress(active);
    if (commits) commit(active.key);
  }, [commit, releasePress]);

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const active = presses.current.get(event.pointerId);
    if (!active) return;
    active.cancelled = true;
    releasePress(active);
  }, [releasePress]);

  const rows = deckRows(state);
  rowsRef.current = rows;
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
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(event) => event.preventDefault()}
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
              data-deck-row=""
              className={`flex ${centred ? "justify-center" : ""}`}
              style={{ height: metrics.keycapHeight, gap: metrics.horizontalKeyGap }}
            >
              {keys.map((key, keyIndex) => {
                const special = isSpecialKey(key);
                const lit = key.kind === "shift" && state.shift !== "off";
                const widened = widensOuterGaps
                  && (keyIndex === 1 || keyIndex === keys.length - 1);
                const id = deckKeyId(key);
                return (
                  <button
                    key={id}
                    type="button"
                    data-testid={`deck-key-${id}`}
                    data-pressed={pressedKeyIds.includes(id)}
                    aria-label={deckKeyName(key)}
                    // Tri-state, matching the accessibility value iOS sets: armed for one letter
                    // reads as partial, caps lock as fully on.
                    aria-pressed={key.kind === "shift"
                      ? (state.shift === "locked" ? true : state.shift === "on" ? "mixed" : false)
                      : undefined}
                    data-shift={key.kind === "shift" ? state.shift : undefined}
                    // Presentational: the deck resolves touches to tiled cells, so the keycap is
                    // where the key is drawn, not where it is hit. Left focusable and labelled for
                    // assistive technology, which still drives the element rather than a point.
                    tabIndex={-1}
                    style={{
                      fontSize: titleSize(key),
                      marginLeft: widened ? outerGap : undefined,
                      ...(centred
                        ? { width: "var(--kbd-key-w)", flex: "none" }
                        : { flexGrow: keyWidthWeight(key), flexBasis: 0, minWidth: 0 }),
                    }}
                    // `touch-action` does not inherit, so the deck's own value does not reach the
                    // keys: without this a press that drifts scrolls the page instead of typing.
                    // `pointer-events-none` keeps every touch on the deck, where the cells decide.
                    className={`pointer-events-none touch-none rounded-lg leading-none text-black transition-none dark:text-white
                      data-[pressed=true]:translate-y-px
                      focus-visible:outline-2 focus-visible:outline-ring
                      ${lit ? ACTIVE_FILL : special ? SPECIAL_FILL : REGULAR_FILL}
                      ${special ? SPECIAL_SHADOW : REGULAR_SHADOW}`}
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
