import { useCallback, useRef, useState, type FormEvent, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type CompositionEvent as ReactCompositionEvent } from "react";
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
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useEventListener } from "@/hooks/dom/useEventListener";
import { useResizeObserver } from "@/hooks/dom/useResizeObserver";
import { useMountEffect, useUnmountEffect } from "@/hooks/useMountEffect";
import { useNotify } from "@/hooks/useNotify";
import { useLatestRef } from "@/hooks/useLatestRef";

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
  const [deckAvailable] = useState(drawsOwnKeyboard);
  const showsDeck = deckAvailable && keyboardMode === "deck";
  const showsDeckRef = useLatestRef(showsDeck);
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
  const draftRef = useLatestRef(draft);
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
  const ctxRef = useLatestRef(ctx);

  const setKeyboardMode = useCallback((mode: KeyboardMode) => session.setKeyboardMode(ctxRef.current, mode), [ctxRef]);
  const updatePresentation = useCallback((action: KeyboardPresentationAction) => session.updatePresentation(ctxRef.current, action), [ctxRef]);
  const clearFocusTimer = useCallback(() => session.clearFocusTimer(ctxRef.current), [ctxRef]);
  const clearLocalState = useCallback((action: "hide" | "transport-close", reason?: string) => session.clearLocalState(ctxRef.current, action, reason ?? action), [ctxRef]);
  const hide = useCallback(() => session.hide(ctxRef.current), [ctxRef]);
  const setAutoKeyboard = useCallback((enabled: boolean) => session.setAutoKeyboard(ctxRef.current, enabled), [ctxRef]);
  const sendControl = useCallback((input: DesktopControlInput) => send.sendControl(ctxRef.current, input), [ctxRef]);
  const pasteFromClipboard = useCallback(() => send.pasteFromClipboard(ctxRef.current), [ctxRef]);
  const cancelDraft = useCallback(() => send.cancelDraft(ctxRef.current), [ctxRef]);
  const sendDraft = useCallback(() => send.sendDraft(ctxRef.current), [ctxRef]);
  const sendDeckCharacter = useCallback((character: string) => send.sendDeckCharacter(ctxRef.current, character), [ctxRef]);
  const sendDeckCursorDelta = useCallback((delta: number) => send.sendDeckCursorDelta(ctxRef.current, delta), [ctxRef]);
  const sendChromeKey = useCallback((code: RemoteKeyCode) => send.sendChromeKey(ctxRef.current, code), [ctxRef]);
  const deckBackspace = useCallback(() => send.deckBackspace(ctxRef.current), [ctxRef]);
  const tapModifier = useCallback((modifier: RemoteModifier) => send.tapModifier(ctxRef.current, modifier), [ctxRef]);
  const beforeRemoteClick = useCallback(() => capture.beforeRemoteClick(ctxRef.current), [ctxRef]);
  const consumePointerGesture = useCallback(() => capture.consumePointerGesture(ctxRef.current), [ctxRef]);
  const showManually = useCallback(() => capture.showManually(ctxRef.current), [ctxRef]);
  const onBeforeInput = useCallback((input: InputEvent) => capture.onBeforeInput(ctxRef.current, input), [ctxRef]);
  const onInput = useCallback((event: FormEvent<HTMLTextAreaElement>) => capture.onInput(ctxRef.current, event), [ctxRef]);
  const onPaste = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>) => capture.onPaste(ctxRef.current, event), [ctxRef]);
  const onCompositionStart = useCallback(() => capture.onCompositionStart(ctxRef.current), [ctxRef]);
  const onCompositionEnd = useCallback((event: ReactCompositionEvent<HTMLTextAreaElement>) => capture.onCompositionEnd(ctxRef.current, event), [ctxRef]);
  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => capture.onKeyDown(ctxRef.current, event), [ctxRef]);
  const onBlur = useCallback(() => capture.onBlur(ctxRef.current), [ctxRef]);
  const handleControlEvent = useCallback((event: DesktopControlEvent) => control.handleControlEvent(ctxRef.current, event), [ctxRef]);

  // The keyboard follows its transport: open, it may present; closed, everything local goes.
  useNotify(transport, (next) => {
    transportRef.current = next;
    if (next) {
      updatePresentation({ type: "transport-open" });
    } else {
      clearLocalState("transport-close");
    }
  });

  useUnmountEffect(() => {
    clearFocusTimer();
    if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
  });

  // React 19 polyfills onBeforeInput from textInput/keypress and misses native deletes.
  useEventListener<InputEvent>(captureRef, "beforeinput", onBeforeInput);

  const viewport = window.visualViewport;
  const followViewport = () => {
    if (!viewport) return;
    {
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
    }
  };
  useMountEffect(followViewport);
  useEventListener(viewport, "resize", followViewport);
  useEventListener(viewport, "scroll", followViewport);
  useEventListener(viewport ? window : null, "resize", followViewport);

  const keyboardPresented = presentation.presentation === "pending"
    || presentation.presentation === "shown";
  // Measured again from nothing each time the keyboard comes or goes.
  const [measuredFor, setMeasuredFor] = useState(keyboardPresented);
  if (measuredFor !== keyboardPresented) {
    setMeasuredFor(keyboardPresented);
    setAccessoryHeight(0);
  }

  // The accessory's height is measured rather than known: its bottom padding follows the safe area
  // until the software keyboard actually owns it, and the key rail is free to change shape. The
  // viewer subtracts this from the video, so a stale guess here is a band of Mac nobody can see.
  const measureAccessory = () => {
    const accessory = accessoryRef.current;
    if (accessory) setAccessoryHeight(Math.ceil(accessory.getBoundingClientRect().height));
  };
  useDomSync(measureAccessory, [keyboardPresented]);
  // Re-observed whenever the keyboard comes or goes, since the accessory is drawn with it.
  useResizeObserver(keyboardPresented ? accessoryRef : null, measureAccessory);

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
