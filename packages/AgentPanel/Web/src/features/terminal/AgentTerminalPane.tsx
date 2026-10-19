import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { AgentTerminalContext } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { drawsOwnKeyboard } from "@/features/keyboard/softwareKeyboard";
import { KEEP_IN_SIGHT_ATTRIBUTE } from "@/app/page/keyboardInset";
import { terminalContextLabel } from "@/features/terminal/terminalContext";
import { TerminalKeyRail } from "@/features/terminal/TerminalKeyRail";
import { TerminalRestartButton } from "@/features/terminal/TerminalRestartButton";
import { paneRoomBesideTranscript } from "@/features/terminal/terminalPaneRoom";
import { keepLastDrawnRowInView } from "@/features/terminal/lastDrawnRowInView";
import { TERMINAL_ZOOM, useAgentTerminal, type AgentTerminalState } from "@/features/terminal/useAgentTerminal";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useEventListener } from "@/hooks/dom/useEventListener";
import { useResizeObserver } from "@/hooks/dom/useResizeObserver";

const MINIMUM_TERMINAL_HEIGHT = 150;
const MAXIMUM_TERMINAL_SHARE = 0.72;
const BAND_TERMINAL_SHARE = 0.42;
/** An echo's share of its column: half the share a pane may grow to, so a peek stays a peek. */
const ECHO_TERMINAL_SHARE = MAXIMUM_TERMINAL_SHARE / 2;
const echoHeight = (basis: number): number =>
  Math.max(MINIMUM_TERMINAL_HEIGHT, Math.round(basis * ECHO_TERMINAL_SHARE));

/**
 * What a band pane is a share of when it is given nothing else to measure: what is actually
 * visible.
 *
 * The visual viewport rather than `innerHeight`, because a phone keyboard covers the bottom of the
 * layout viewport without shortening it. The document gives that strip back (keyboardInset.ts), so
 * a pane still sized against the full layout viewport would be taller than the shell it now sits
 * in and would squeeze the transcript above it to nothing.
 *
 * Only right for a band that fills the page. A band inside anything smaller is handed that
 * something instead, through `heightBasis`.
 *
 * 0 rather than NaN off a window, so every share of it clamps to the minimum instead.
 */
const viewportHeight = (): number => globalThis.visualViewport?.height || globalThis.innerHeight || 0;

interface Props {
  feed: SidecarDataSource;
  context: AgentTerminalContext;
  /**
   * Watches the terminal's own state, for a caller that has something to do with it.
   *
   * Optional because not every pane does: the fork pane renders its errors in its own footer and
   * the shell above it knows the fork's name before the terminal exists, so it has nothing to
   * learn here and a no-op passed only to satisfy a signature is noise.
   */
  onState?: (context: AgentTerminalContext, state: AgentTerminalState) => void;
  /**
   * Where the pane's height comes from, which also decides which way a drag grows.
   *
   * `column` (the default) is a pane sharing a fixed-height column with a transcript, so it
   * opens at a share of that column and its ceiling is a share of it too.
   *
   * `band` is a pane whose own height IS the height of the band holding it. Nothing reserves a
   * box around it -- a share of the parent would measure the pane itself, and a reserved box
   * leaves whatever the pane does not fill blank -- so it opens at a share of the surface holding
   * the band, and takes its ceiling from there too. Growing it makes the band taller, which moves
   * the band's top edge up: the direction a handle along the pane's top edge implies.
   *
   * `echo` is a band that is a PEEK rather than a place to work: it holds a fixed share of its
   * column instead of the height its screen wants, and keeps the BOTTOM of that screen in view. It
   * exists so a reader can watch their own typing arrive in the agent's composer line while still
   * having the field to type it in, and the line they are watching is the last one on the screen.
   * Still draggable: a peek that turns out to be worth more room is one drag from having it.
   */
  layout?: "column" | "band" | "echo";
  /**
   * What a `band` pane's height is a share OF. The viewport when this is absent.
   *
   * A band cannot measure its own parent -- the parent is the band, and the band's height is this
   * pane's -- so it needs an outside reference, and the viewport is only the right one when the
   * surface holding the band IS the page. Inside a Bot card it is not: a share of the viewport is
   * most of a screen and more than the whole card, so the pane opens taller than the thing holding
   * it and squeezes everything above it away. Hand it the column instead and the same arithmetic
   * is right on both surfaces.
   *
   * The ELEMENT, not a ref to it, and that distinction was measured rather than reasoned: React
   * attaches refs child-first, so a ref handed down from a parent is still null while this pane's
   * own effects run, and a pane that read one fell back to the viewport for good. An element
   * arrives as a prop, which means it arrives in a render, which is when it can be used.
   */
  heightBasis?: HTMLElement | null;
  /**
   * Whether this pane asks a tmux session to take its shape, or leaves it alone and scales the
   * type. Defaults from `layout`, which is almost always the right answer -- see below.
   */
  paneShape?: "adopt" | "follow";
  /**
   * The height a reader dragged this pane to on an earlier visit, or null for one nobody has.
   *
   * Read once, when the pane mounts. It outranks the opening height the grid would ask for, the
   * same way a drag in this visit does: both are the reader saying what they want, and the only
   * difference is which visit they said it in.
   *
   * Where it is REMEMBERED is not this component's business and deliberately so. A pane is shown
   * in several places that mean different things by "the same pane", and one of them -- the zoom
   * below -- is remembered nowhere on purpose. Whoever renders the pane knows which of those it
   * is; the pane knows only that it was handed a height.
   */
  rememberedHeight?: number | null;
  /** Every height the reader chooses, already clamped to what the pane will actually take. */
  onResized?: (height: number) => void;
}

/** The resizable terminal under one thread. The protocol is the hook's; this is its chrome. */
export function AgentTerminalPane({
  feed,
  context,
  onState,
  layout = "column",
  heightBasis,
  paneShape,
  rememberedHeight = null,
  onResized,
}: Props) {
  const paneRef = useRef<HTMLDivElement>(null);
  const removeResizeListenersRef = useRef<() => void>(() => {});
  // Whether the viewer has sized this pane themselves, which outranks anything the grid prefers.
  // A remembered height is that, made on an earlier visit, so it starts the pane already sized.
  const sized = useRef(rememberedHeight !== null);
  // An echo is a band for every purpose that involves height coming from outside the pane. What it
  // is not is a band that opens at the size of its screen.
  const echo = layout === "echo";
  const band = layout === "band" || echo;
  const shape = paneShapeForLayout(layout, paneShape);
  const measureBasis = (): number => heightBasis?.clientHeight ?? viewportHeight();
  const [height, setHeight] = useState<number | null>(
    rememberedHeight ??
      (echo
        ? echoHeight(measureBasis())
        : band
          ? Math.max(MINIMUM_TERMINAL_HEIGHT, Math.round(measureBasis() * BAND_TERMINAL_SHARE))
          : null),
  );
  // Only a band pane renders from this: a column pane measures its parent at the moment of a drag.
  const [basis, setBasis] = useState(measureBasis);
  /**
   * The size this reader has asked for, or null while the pane is sizing itself.
   *
   * Not remembered across a reload, deliberately: it costs one press to set again, and a size
   * stored per pane would come back on a card of a different width where it means something else.
   */
  const [zoom, setZoom] = useState<number | null>(null);
  const { mountRef, labels, contentHeight, fontSize, focused, modifiers, toggleModifier, pressKey, lastDrawnRow } =
    useAgentTerminal({
      feed,
      context,
      sizing: { kind: "fit" },
      paneShape: shape,
      zoom,
      onState,
    });
  // Steps from whatever is on screen, so the first press moves from what the reader is looking at
  // rather than from a default they never chose.
  const stepZoom = (by: number): void =>
    setZoom((chosen) => {
      const from = chosen ?? fontSize ?? TERMINAL_ZOOM.minimum;
      return Math.min(TERMINAL_ZOOM.maximum, Math.max(TERMINAL_ZOOM.minimum, Math.round(from) + by));
    });
  // Read once per pane rather than at import: a browser does not grow a software keyboard part way
  // through a session, but a test has to be able to say which kind of browser it is.
  const [softwareKeyboard] = useState(drawsOwnKeyboard);
  // Only where the keyboard is missing these keys, and only while that keyboard is up: a desktop
  // browser has Esc and Ctrl already, and a rail standing there permanently would spend height on
  // a terminal nobody is typing into.
  const showsKeyRail = focused && softwareKeyboard;

  // An element answers every question the two window events answer and one they do not: the
  // surface can change height without the window doing anything, which is what happens when a
  // card is opened above this one. A keyboard still reaches it, because the inset shortens the
  // document and every column in it shortens too. Without one, both window events, because they
  // answer different questions: `visualViewport` is the one a keyboard moves, and `window` is the
  // one a rotation or a desktop window resize moves.
  const measureBand = (): void => {
    if (band) setBasis(heightBasis ? heightBasis.clientHeight : viewportHeight());
  };
  useDomSync(measureBand, [band, heightBasis]);
  useResizeObserver(band ? heightBasis : null, measureBand);
  const followsViewport = band && !heightBasis;
  useEventListener(followsViewport ? globalThis.visualViewport : null, "resize", measureBand);
  useEventListener(followsViewport ? globalThis : null, "resize", measureBand);

  /**
   * The tallest a band pane is any use at: its whole screen at the width it has, plus the pane's
   * own chrome. A band never reshapes the session, so past this a drag only adds blank, and on a
   * phone that blank was most of a tall pane with the screen small at its foot (2026-10-17).
   * Measured after layout rather than during render; the chrome moves with the key rail.
   */
  const [wholeScreen, setWholeScreen] = useState<number | null>(null);
  useDomSync(() => {
    const pane = paneRef.current;
    const mount = mountRef.current;
    const known = band && contentHeight !== null && contentHeight > 0 && pane && mount;
    setWholeScreen(known ? contentHeight + pane.offsetHeight - mount.clientHeight : null);
  }, [band, contentHeight, showsKeyRail, mountRef]);
  const share = (available: number): number =>
    Math.max(MINIMUM_TERMINAL_HEIGHT, Math.min(available * MAXIMUM_TERMINAL_SHARE, wholeScreen ?? Infinity));
  const ceiling = (): number => share(band ? basis : (paneRef.current?.parentElement?.clientHeight ?? 0));
  /** The most a band pane may take sizing itself: the ceiling, short of crowding the transcript. */
  const selfCeiling = (): number => {
    const room = band && heightBasis && paneRef.current ? paneRoomBesideTranscript(paneRef.current, heightBasis) : null;
    return room === null ? ceiling() : Math.max(MINIMUM_TERMINAL_HEIGHT, Math.min(ceiling(), room));
  };
  // The height asked for is kept, and the ceiling applied on top of it, so a keyboard that forces
  // the pane down to fit gives its size back when it closes rather than costing the user the drag.
  const appliedHeight = height !== null && band ? Math.min(height, share(basis)) : height;

  /**
   * Opens at the height the screen actually needs, once that is known.
   *
   * A band pane's opening height was a flat share of its surface, which is a guess made before it
   * has seen the screen: the same 20-row tmux pane scrolled off the bottom of a card's band and
   * left the type small in a window's. The grid's own height answers both -- at that height the
   * whole screen is visible at the type's base size -- and the surface still caps it, so a
   * 50-row pane in a short card shrinks the type rather than eating the card.
   *
   * Never over a drag: a viewer who has sized this pane has said what they want, and a later
   * checkpoint must not take it back.
   */
  useDomSync(() => {
    if (!band || echo || contentHeight === null || !(contentHeight > 0) || sized.current) return;
    const pane = paneRef.current;
    const mount = mountRef.current;
    if (!pane || !mount) return;
    // `offsetHeight`, not `clientHeight`: the height being set is a border-box one, so a chrome
    // measured without the border is a pixel short -- and a pixel short is a whole point of type,
    // because the fit floors.
    const chrome = pane.offsetHeight - mount.clientHeight;
    setHeight(Math.min(selfCeiling(), Math.max(MINIMUM_TERMINAL_HEIGHT, contentHeight + chrome)));
    // `ceiling` reads the basis this render measured; re-running it on every render would fight
    // the drag rather than follow the grid.
  }, [band, contentHeight]);

  /**
   * Keeps an echo's last drawn row at its bottom edge (`lastDrawnRowInView.ts`). Re-run when that
   * row moves rather than on every write, on the screen's height, which a reflow moves, and on
   * `height`, because a reader dragging the peek taller changes how much fits above it.
   */
  useDomSync(() => {
    if (echo && mountRef.current) keepLastDrawnRowInView(mountRef.current, lastDrawnRow);
  }, [echo, contentHeight, height, lastDrawnRow, mountRef]);

  /**
   * Holds an echo at a fixed share of the session's column, whatever its program has drawn.
   *
   * It used to open at the height its drawn rows needed and grow with them, so a pane sat small
   * until its program filled the screen and then took most of the column: a lane's pane grew while
   * opencode streamed and Claude's grew turn by turn, and the transcript shrank under the reader.
   * A share of the column is the same size from the first frame and follows the screen when it
   * resizes. Still never past what leaves the transcript its floor, and never over a drag.
   */
  useDomSync(() => {
    if (!echo || sized.current) return;
    setHeight(Math.min(selfCeiling(), echoHeight(basis)));
    // `selfCeiling` reads the layout this render measured; the basis is what moves it.
  }, [echo, basis]);

  /**
   * The one place a reader-chosen height is set, which is why the report goes out from here.
   *
   * The drag and the keyboard both arrive through it, so there is no second call site to forget.
   * It reports the CLAMPED height rather than the one asked for: what comes back on the next
   * visit should be what the pane was, not a number it refused.
   */
  const resizeTo = (requestedHeight: number): void => {
    if (!paneRef.current) return;
    sized.current = true;
    const next = Math.min(ceiling(), Math.max(MINIMUM_TERMINAL_HEIGHT, requestedHeight));
    setHeight(next);
    onResized?.(next);
  };

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const pane = paneRef.current;
    if (!pane) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // Where the finger is on the GLASS, not in the page. With a phone keyboard up, iOS pans the
    // page under a still finger to keep the caret in sight, and the pane growing is what makes it
    // pan: read in the page, a drag upward read as one downward and shrank the pane to its minimum.
    const onGlass = (pointer: { screenY: number }): number => pointer.screenY / (globalThis.visualViewport?.scale || 1);
    const startY = onGlass(event);
    const startHeight = pane.getBoundingClientRect().height;
    const move = (moveEvent: PointerEvent): void => {
      resizeTo(startHeight - (onGlass(moveEvent) - startY));
    };
    const finish = (): void => {
      globalThis.removeEventListener("pointermove", move);
      globalThis.removeEventListener("pointerup", finish);
      globalThis.removeEventListener("pointercancel", finish);
      removeResizeListenersRef.current = () => {};
    };
    removeResizeListenersRef.current();
    removeResizeListenersRef.current = finish;
    globalThis.addEventListener("pointermove", move);
    globalThis.addEventListener("pointerup", finish, { once: true });
    globalThis.addEventListener("pointercancel", finish, { once: true });
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const pane = paneRef.current;
    if (!pane) return;
    const currentHeight = pane.getBoundingClientRect().height;
    let nextHeight: number | null = null;
    if (event.key === "ArrowUp") nextHeight = currentHeight + 24;
    if (event.key === "ArrowDown") nextHeight = currentHeight - 24;
    if (event.key === "Home") nextHeight = MINIMUM_TERMINAL_HEIGHT;
    if (event.key === "End") nextHeight = ceiling();
    if (nextHeight === null) return;
    event.preventDefault();
    resizeTo(nextHeight);
  };

  return (
    <section
      ref={paneRef}
      aria-label={`${terminalContextLabel(context)} terminal`}
      // What a phone keyboard must not cover while the terminal has focus: the whole pane, key rail
      // included, rather than xterm's hidden field alone (`keepTypingInSight`).
      {...{ [KEEP_IN_SIGHT_ATTRIBUTE]: "" }}
      // Its own key rail stands under it, so the keyboard bar does not stand on the keyboard too.
      data-keyboard-bar="off"
      className={`flex min-h-[150px] shrink-0 flex-col border-t border-border ${band ? "" : "h-[38%]"}`}
      style={appliedHeight === null ? undefined : { height: appliedHeight }}
    >
      <button
        type="button"
        role="separator"
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
        // `touch-none`, or a phone takes the drag for a scroll a few pixels in and cancels it.
        className="group relative h-2 shrink-0 cursor-row-resize touch-none bg-card focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="absolute inset-x-0 top-0 h-px bg-border transition-colors group-hover:bg-primary" />
      </button>
      {/* The dark surface is the SCREEN, not the band.

          A grid this side does not own is rarely this box's shape -- a 41-column tmux pane in a
          window-wide band is a third of its width -- so a background painted across the band left
          most of a black rectangle with nothing in it, which reads as something failing rather
          than as a terminal. The screen is centred and carries its own background and padding, and
          the band around it is the surface the pane sits on.
          
          This mount stays the full band, because it is what the type is fitted against, and it
          still scrolls rather than clips for the case the scaling cannot reach: a grid so large the
          type would stop being readable stays readable and moves instead, since clipping it hid the
          part of the screen the cursor was on.

          Vertical padding only. The transcript's event cards run edge to edge across this column,
          and the screen is another card in that stack: a horizontal inset of its own would set it
          in from every card above it by the width of that inset, which reads as a misalignment
          rather than as breathing room. Its own `p-2` is inside the surface, the way a card's is.

          Centred by the screen's own auto margins rather than by `justify`/`items`: a flex box
          that centres its item clips the top of one too large to fit, where auto margins fall back
          to the start edge and leave it scrollable. `box-content` for the same reason in the other
          direction -- stretched to the box, the screen's padding would come out of its own height
          instead of adding to it, and the last row would sit outside the surface it is drawn on. */}
      <div
        ref={mountRef}
        className="flex min-h-0 flex-1 overflow-auto py-3 [&>.xterm]:m-auto [&>.xterm]:box-content [&>.xterm]:shrink-0 [&>.xterm]:rounded-lg [&>.xterm]:bg-white [&>.xterm]:p-2 dark:[&>.xterm]:bg-[#0b0e14]"
      />
      {showsKeyRail ? <TerminalKeyRail modifiers={modifiers} onModifier={toggleModifier} onKey={pressKey} /> : null}
      <footer className="flex min-h-6 shrink-0 items-center gap-3 overflow-hidden border-t border-border px-2 font-mono text-[10px] text-muted-foreground">
        <span>{labels.sync}</span>
        {labels.ownership ? <span>{labels.ownership}</span> : null}
        {labels.source ? <span>{labels.source}</span> : null}
        {labels.view ? <span>{labels.view}</span> : null}
        {/* Pushed to the end and last in the tab order: the labels are what a reader comes here to
            read, and the type size is what they come here to change. */}
        <span className="ml-auto flex min-w-0 items-center gap-0.5">
          {/* A Claude session's own pane only: the restart re-runs it under the launch flags, and
              no other target has a launch to re-run. */}
          {context.kind === "session-tmux" && context.source === "claude" ? (
            <TerminalRestartButton feed={feed} context={context} />
          ) : null}
          <TerminalZoomButton
            label="Smaller type"
            onPress={() => stepZoom(-TERMINAL_ZOOM.step)}
            disabled={(zoom ?? fontSize ?? 0) <= TERMINAL_ZOOM.minimum}
          >
            −
          </TerminalZoomButton>
          {/* The size in force, and the way back to letting the pane choose it. Shown as a number
              rather than a percentage because the fit has no 100% to be a percentage OF: the
              screen's size is whatever its grid and this box work out to. */}
          <button
            type="button"
            onClick={() => setZoom(null)}
            disabled={zoom === null}
            aria-label={zoom === null ? "Type is sized to the pane" : "Size the type to the pane"}
            title={zoom === null ? "Sized to the pane" : "Size to the pane"}
            className="min-w-8 cursor-pointer rounded px-1 text-center tabular-nums outline-none transition-colors hover:bg-muted enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
          >
            {fontSize === null ? "--" : `${Math.round(fontSize)}pt`}
          </button>
          <TerminalZoomButton
            label="Larger type"
            onPress={() => stepZoom(TERMINAL_ZOOM.step)}
            disabled={(zoom ?? fontSize ?? 0) >= TERMINAL_ZOOM.maximum}
          >
            +
          </TerminalZoomButton>
        </span>
      </footer>
    </section>
  );
}

/**
 * A BAND never reshapes the session; a full surface does.
 *
 * Derived from the layout rather than asked of every caller, because the layout is exactly the
 * thing that decides it and a caller that forgets gets the destructive answer -- and the three call
 * sites that had it wrong were the ones nobody thought about: the composer's band, a new session's
 * card, and a fork's.
 *
 * A band is a strip by construction, a card's being a few hundred pixels, and a tmux window has one
 * size for everyone. So a band that claimed shrank the live session to its own shape: measured
 * 2026-09-08 at 48x9 and 56x16, small enough that Claude's TUI redrew its whole frame continuously,
 * and still that size after the band was closed. A column pane fills the session's own view and is
 * somewhere a reader works, so it still takes the shape it can use.
 *
 * The override exists for the surface that is neither, of which there is none today.
 */
export function paneShapeForLayout(
  layout: "column" | "band" | "echo",
  override?: "adopt" | "follow",
): "adopt" | "follow" {
  // An echo follows for the same reason a band does, and harder: it is shorter than a band, so a
  // claim from one would pin the session smaller than the shape that made this rule.
  return override ?? (layout === "column" ? "adopt" : "follow");
}

/**
 * One press of the zoom control.
 *
 * A real button rather than an icon: at this size a glyph is a smudge, and `−`/`+` read at ten
 * pixels where an outline does not. The touch target is larger than the text it holds, because the
 * footer is the shortest strip on the pane and a thumb still has to land on it. Its text goes to
 * full ink on hover: the footer's muted ink measured 4.3:1 on the hover fill, under the 4.5:1 line.
 */
function TerminalZoomButton({
  label,
  onPress,
  disabled,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex size-5 cursor-pointer items-center justify-center rounded text-xs leading-none outline-none transition-colors hover:bg-muted enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
