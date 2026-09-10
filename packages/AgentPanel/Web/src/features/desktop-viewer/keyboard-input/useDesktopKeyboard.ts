import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type CompositionEvent as ReactCompositionEvent,
} from "react";
import type {
  DesktopControlEvent,
  DesktopControlInput,
  DesktopCursorKind,
  RemoteKeyCode,
  RemoteKeyEvent,
  RemoteModifier,
} from "@agentdesk/agent-feed-wire";
import type { DesktopControlTransport } from "@/features/desktop-viewer/tile-stream/TileStreamRtc";
import {
  INITIAL_KEYBOARD_PRESENTATION,
  KEYBOARD_VIEWPORT_SHRINK_PX,
  KEYBOARD_VIEWPORT_RESTORE_TOLERANCE_PX,
  type KeyboardPresentationAction,
  type KeyboardPresentationState,
  type ModifierState,
} from "@/features/desktop-viewer/keyboard-input/desktopKeyboardModel";
import { drawsOwnKeyboard } from "@/features/desktop-viewer/keyboard-deck/keyboardDeckModel";
import * as capture from "@/features/desktop-viewer/keyboard-input/desktopKeyboardCapture";
import * as control from "@/features/desktop-viewer/keyboard-input/desktopKeyboardControl";
import * as send from "@/features/desktop-viewer/keyboard-input/desktopKeyboardSend";
import * as session from "@/features/desktop-viewer/keyboard-input/desktopKeyboardSession";
import {
  OFF_MODIFIERS,
  storedAutoKeyboard,
  storedKeyboardMode,
} from "@/features/desktop-viewer/keyboard-input/desktopKeyboardPreferences";
import type {
  DesktopKeyboardTelemetry,
  KeyboardContext,
  KeyboardMode,
  PendingDelivery,
} from "@/features/desktop-viewer/keyboard-input/desktopKeyboardContext";

// Re-exported: the surface imports the hook, and these are what it hands back.
export type { KeyboardMode, DesktopKeyboardTelemetry } from "@/features/desktop-viewer/keyboard-input/desktopKeyboardContext";

/**
 * The desktop keyboard: what a tap arms, what a keystroke sends, and what the Mac says back.
 *
 * The parts are four files around one context object -- `desktopKeyboardSession.ts` for the
 * keyboard's own state, `desktopKeyboardSend.ts` for putting input on the wire,
 * `desktopKeyboardCapture.ts` for the hidden field the browser reports through, and
 * `desktopKeyboardControl.ts` for what the Mac answers. They are free functions taking that
 * object rather than closures, so the state has exactly one owner: this hook.
 */
export function useDesktopKeyboard({
  transport,
  cursorKind,
  report,
}: {
  transport: DesktopControlTransport | null;
  /** Reads the remote cursor's current shape at tap time; see `shouldPrimeKeyboard`. */
  cursorKind: () => DesktopCursorKind;
  report: (event: DesktopKeyboardTelemetry) => void;
}) {
  const captureRef = useRef<HTMLTextAreaElement>(null);
  const transportRef = useRef(transport);
  const presentationRef = useRef<KeyboardPresentationState>(INITIAL_KEYBOARD_PRESENTATION);
  const [presentation, setPresentation] = useState(INITIAL_KEYBOARD_PRESENTATION);
  const [autoKeyboard, setAutoKeyboardState] = useState(storedAutoKeyboard);
  const [keyboardMode, setKeyboardModeState] = useState<KeyboardMode>(storedKeyboardMode);
  // The platform decides whether a deck is on offer at all; the preference only chooses between
  // the two where both exist. A desktop browser raises no keyboard and has a real one attached.
  const deckAvailable = useRef(drawsOwnKeyboard()).current;
  const showsDeck = deckAvailable && keyboardMode === "deck";
  const showsDeckRef = useRef(showsDeck);
  showsDeckRef.current = showsDeck;
  const [modifiers, setModifiers] = useState<Record<RemoteModifier, ModifierState>>(OFF_MODIFIERS);
  const modifiersRef = useRef(modifiers);
  const [receipt, setReceipt] = useState<string[]>([]);
  const [localEcho, setLocalEcho] = useState<string[]>([]);
  const [deliveryStatus, setDeliveryStatus] = useState<string | null>(null);
  /**
   * The pasted text being edited before it goes, or null when there is nothing to edit.
   *
   * Null is not the same as empty: a draft that has been emptied is still a mode the deck is
   * typing into, and leaving it takes Send or Cancel rather than a backspace.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [accessoryBottom, setAccessoryBottom] = useState(0);
  const [accessoryHeight, setAccessoryHeight] = useState(0);
  const accessoryRef = useRef<HTMLElement>(null);
  const [softwareKeyboardVisible, setSoftwareKeyboardVisible] = useState(false);
  const pendingKeys = useRef<RemoteKeyEvent[]>([]);
  const pendingDeliveries = useRef(new Map<number, PendingDelivery>());
  const nextSequence = useRef(1);
  const focusTimer = useRef<number | null>(null);
  const lastSendFailure = useRef<"channel-closed" | "backpressured">("channel-closed");
  const focusStarted = useRef<{ requestID: string; at: number } | null>(null);
  const composing = useRef(false);
  const compositionCommitEcho = useRef<string | null>(null);
  const sawKeyboardViewport = useRef(false);
  const fullViewportHeight = useRef(window.visualViewport?.height ?? window.innerHeight);
  const handledNativeInput = useRef(false);
  const blurTimer = useRef<number | null>(null);

  const ctx: KeyboardContext = {
    captureRef, transportRef, presentationRef, showsDeckRef, modifiersRef, draftRef, accessoryRef,
    pendingKeys, pendingDeliveries, nextSequence, focusTimer, lastSendFailure, focusStarted,
    composing, compositionCommitEcho, sawKeyboardViewport, fullViewportHeight, handledNativeInput,
    blurTimer, setPresentation, setAutoKeyboardState, setKeyboardModeState, setModifiers,
    setReceipt, setLocalEcho, setDeliveryStatus, setDraft, setAccessoryBottom, setAccessoryHeight,
    setSoftwareKeyboardVisible, report, cursorKind, deckAvailable, autoKeyboard,
  };
  // Read through a ref rather than captured, so every callback below is stable and the parts
  // always see this render's props.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const resetCapture = useCallback(() => session.resetCapture(ctxRef.current), []);
  const focusCapture = useCallback(() => session.focusCapture(ctxRef.current), []);
  const setKeyboardMode = useCallback((mode: KeyboardMode) => session.setKeyboardMode(ctxRef.current, mode), []);
  const updatePresentation = useCallback((action: KeyboardPresentationAction) => session.updatePresentation(ctxRef.current, action), []);
  const clearFocusTimer = useCallback(() => session.clearFocusTimer(ctxRef.current), []);
  const clearLocalState = useCallback((action: "hide" | "transport-close", reason?: string) => session.clearLocalState(ctxRef.current, action, reason ?? action), []);
  const hide = useCallback(() => session.hide(ctxRef.current), []);
  const setAutoKeyboard = useCallback((enabled: boolean) => session.setAutoKeyboard(ctxRef.current, enabled), []);
  const sendControl = useCallback((input: DesktopControlInput) => send.sendControl(ctxRef.current, input), []);
  const sendBatch = useCallback((keys: RemoteKeyEvent[], secure: boolean) => send.sendBatch(ctxRef.current, keys, secure), []);
  const sendText = useCallback((text: string) => send.sendText(ctxRef.current, text), []);
  const pasteFromClipboard = useCallback(() => send.pasteFromClipboard(ctxRef.current), []);
  const appendToDraft = useCallback((character: string) => send.appendToDraft(ctxRef.current, character), []);
  const backspaceDraft = useCallback(() => send.backspaceDraft(ctxRef.current), []);
  const cancelDraft = useCallback(() => send.cancelDraft(ctxRef.current), []);
  const sendDraft = useCallback(() => send.sendDraft(ctxRef.current), []);
  const decorateWithStickyModifiers = useCallback((keys: RemoteKeyEvent[]) => send.decorateWithStickyModifiers(ctxRef.current, keys), []);
  const acceptEncodedKeys = useCallback((keys: RemoteKeyEvent[]) => send.acceptEncodedKeys(ctxRef.current, keys), []);
  const acceptText = useCallback((text: string) => send.acceptText(ctxRef.current, text), []);
  const sendDeckCharacter = useCallback((character: string) => send.sendDeckCharacter(ctxRef.current, character), []);
  const sendDeckCursorDelta = useCallback((delta: number) => send.sendDeckCursorDelta(ctxRef.current, delta), []);
  const sendChromeKey = useCallback((code: RemoteKeyCode) => send.sendChromeKey(ctxRef.current, code), []);
  const deckBackspace = useCallback(() => send.deckBackspace(ctxRef.current), []);
  const tapModifier = useCallback((modifier: RemoteModifier) => send.tapModifier(ctxRef.current, modifier), []);
  const prepareCapture = useCallback(() => capture.prepareCapture(ctxRef.current), []);
  const beforeRemoteClick = useCallback(() => capture.beforeRemoteClick(ctxRef.current), []);
  const consumePointerGesture = useCallback(() => capture.consumePointerGesture(ctxRef.current), []);
  const showManually = useCallback(() => capture.showManually(ctxRef.current), []);
  const onBeforeInput = useCallback((input: InputEvent) => capture.onBeforeInput(ctxRef.current, input), []);
  const onInput = useCallback((event: FormEvent<HTMLTextAreaElement>) => capture.onInput(ctxRef.current, event), []);
  const onPaste = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>) => capture.onPaste(ctxRef.current, event), []);
  const onCompositionStart = useCallback(() => capture.onCompositionStart(ctxRef.current), []);
  const onCompositionEnd = useCallback((event: ReactCompositionEvent<HTMLTextAreaElement>) => capture.onCompositionEnd(ctxRef.current, event), []);
  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => capture.onKeyDown(ctxRef.current, event), []);
  const onBlur = useCallback(() => capture.onBlur(ctxRef.current), []);
  const handleControlEvent = useCallback((event: DesktopControlEvent) => control.handleControlEvent(ctxRef.current, event), []);

  useEffect(() => {
    transportRef.current = transport;
    if (transport) {
      updatePresentation({ type: "transport-open" });
    } else {
      clearLocalState("transport-close");
    }
  }, [clearLocalState, transport, updatePresentation]);

  useEffect(() => () => {
    clearFocusTimer();
    if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
  }, [clearFocusTimer]);

  // React 19 polyfills onBeforeInput from textInput/keypress and misses native deletes.
  useEffect(() => {
    // Named `field` rather than `capture`, which is the module of capture handlers here.
    const field = captureRef.current;
    field?.addEventListener("beforeinput", onBeforeInput);
    return () => field?.removeEventListener("beforeinput", onBeforeInput);
  }, [onBeforeInput]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const update = () => {
      const bottom = Math.max(0, window.innerHeight - (viewport.offsetTop + viewport.height));
      setAccessoryBottom(bottom);
      const typing = presentationRef.current.presentation === "shown" || presentationRef.current.presentation === "pending";
      if (!typing) fullViewportHeight.current = viewport.height;
      // Only the browser's keyboard shrinks the viewport. The deck is part of the page, so a
      // shrink while it is showing is someone else's and says nothing about how text arrives.
      if (typing && !showsDeckRef.current
          && viewport.height < fullViewportHeight.current - KEYBOARD_VIEWPORT_SHRINK_PX) {
        sawKeyboardViewport.current = true;
        setSoftwareKeyboardVisible(true);
      }
      if (typing) {
        report({ phase: "keyboard-state", detail: {
          event: "viewport", height: Math.round(viewport.height), layoutHeight: window.innerHeight,
          fullHeight: Math.round(fullViewportHeight.current), bottom: Math.round(bottom),
          offsetTop: Math.round(viewport.offsetTop), captureFocused: document.activeElement === captureRef.current,
        } });
      }
      // The viewport coming back means the browser's keyboard left, which is a dismissal only
      // while it was the one typing. Switching to the deck dismisses it too, and that is the deck
      // arriving rather than the keyboard going.
      if (sawKeyboardViewport.current
          && !showsDeckRef.current
          && viewport.height >= fullViewportHeight.current - KEYBOARD_VIEWPORT_RESTORE_TOLERANCE_PX
          && typing) {
        clearLocalState("hide", "viewport-restored");
      }
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [clearLocalState, report]);

  const keyboardPresented = presentation.presentation === "pending"
    || presentation.presentation === "shown";

  // The accessory's height is measured rather than known: its bottom padding follows the safe area
  // until the software keyboard actually owns it, and the key rail is free to change shape. The
  // viewer subtracts this from the video, so a stale guess here is a band of Mac nobody can see.
  useEffect(() => {
    const accessory = accessoryRef.current;
    if (!accessory) return;
    const measure = () => setAccessoryHeight(Math.ceil(accessory.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(accessory);
    return () => {
      observer.disconnect();
      setAccessoryHeight(0);
    };
  }, [keyboardPresented]);

  return {
    captureRef,
    accessoryRef,
    presentation,
    keyboardPresented,
    autoKeyboard,
    modifiers,
    receipt,
    localEcho,
    deliveryStatus,
    accessoryBottom,
    /**
     * The band at the bottom of the layout viewport that the keyboard and its accessory cover,
     * which is the accessory's top edge. One number for both occluders, because the accessory is
     * drawn on top of the keyboard: `accessoryBottom` is 0 when the WKWebView's layout viewport
     * has already shrunk to the keyboard-free area and the keyboard's own height when it has not,
     * so the answer is the same visible band either way.
     */
    occludedBottom: accessoryBottom + accessoryHeight,
    softwareKeyboardVisible,
    sendControl,
    handleControlEvent,
    beforeRemoteClick,
    consumePointerGesture,
    showManually,
    hide,
    sendChromeKey,
    deckAvailable,
    showsDeck,
    keyboardMode,
    setKeyboardMode,
    sendDeckCharacter,
    sendDeckCursorDelta,
    deckBackspace,
    draft,
    sendDraft,
    cancelDraft,
    pasteFromClipboard,
    tapModifier,
    setAutoKeyboard,
    captureProps: {
      onInput,
      onPaste,
      onCompositionStart,
      onCompositionEnd,
      onKeyDown,
      onBlur,
    },
  };
}
