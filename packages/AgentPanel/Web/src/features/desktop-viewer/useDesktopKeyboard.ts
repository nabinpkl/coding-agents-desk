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
import {
  DESKTOP_CONTROL_MAX_KEY_BATCH,
  DESKTOP_CONTROL_MAX_MESSAGE_BYTES,
  DESKTOP_CONTROL_MAX_TEXT_UNITS,
} from "@agentdesk/agent-feed-wire";
import type { DesktopControlTransport } from "./TileStreamRtc";
import {
  activeModifiers,
  appendLocalEcho,
  clearArmedModifiers,
  cycleModifier,
  INITIAL_KEYBOARD_PRESENTATION,
  keyboardPresentationReducer,
  KEYBOARD_FOCUS_TIMEOUT_MS,
  KEYBOARD_VIEWPORT_SHRINK_PX,
  KEYBOARD_VIEWPORT_RESTORE_TOLERANCE_PX,
  MAX_PENDING_KEY_EVENTS,
  MAX_RECEIPT_EVENTS,
  receiptToken,
  REMOTE_MODIFIER_ORDER,
  remoteKeyForCharacter,
  remoteKeysForText,
  shouldPrimeKeyboard,
  type KeyboardPresentationAction,
  type KeyboardPresentationState,
  type ModifierState,
} from "./desktopKeyboardModel";
import { drawsOwnKeyboard } from "./keyboardDeckModel";

const AUTO_KEYBOARD_STORAGE_KEY = "agentdesk.desktop-keyboard-auto.v2";
const KEYBOARD_MODE_STORAGE_KEY = "agentdesk.desktop-keyboard-mode.v1";
// Give WebKit a deletable character even when the local echo is empty.
const CAPTURE_SENTINEL = "\u200b";
const OFF_MODIFIERS: Record<RemoteModifier, ModifierState> = {
  cmd: "off", ctrl: "off", option: "off", shift: "off",
};

/** Which keyboard types: the panel's own deck, or the browser's. */
export type KeyboardMode = "deck" | "native";

function storedKeyboardMode(): KeyboardMode {
  try {
    return window.localStorage.getItem(KEYBOARD_MODE_STORAGE_KEY) === "native" ? "native" : "deck";
  } catch {
    return "deck";
  }
}

function storedAutoKeyboard(): boolean {
  try {
    return window.localStorage.getItem(AUTO_KEYBOARD_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export interface DesktopKeyboardTelemetry {
  phase: string;
  detail: Record<string, unknown>;
}

interface PendingDelivery {
  tokens: string[];
  secure: boolean;
}

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

  const resetCapture = useCallback(() => {
    const capture = captureRef.current;
    if (!capture) return;
    capture.value = CAPTURE_SENTINEL;
    capture.setSelectionRange(CAPTURE_SENTINEL.length, CAPTURE_SENTINEL.length);
  }, []);

  /**
   * Focus the capture field only where focusing it is the way text arrives.
   *
   * With the browser's keyboard that is exactly what it is: a desktop browser's physical keys need
   * a focused element to land in, and a phone raises its software keyboard from the focus. With
   * the deck it is the opposite -- a focused editable is what summons WebKit's form-navigation
   * strip, which no web API can remove -- so the deck leaves everything unfocused.
   */
  const focusCapture = useCallback(() => {
    if (showsDeckRef.current) return;
    captureRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * Switch which keyboard types, and act on it in the same call.
   *
   * Raising WebKit's keyboard needs a focus inside the tap's own gesture, so this cannot wait for
   * the render that follows the state change; the ref is updated here for the same reason, so a
   * `focusCapture` between now and that render already knows which keyboard is showing.
   */
  const setKeyboardMode = useCallback((mode: KeyboardMode) => {
    setKeyboardModeState(mode);
    showsDeckRef.current = deckAvailable && mode === "deck";
    try {
      window.localStorage.setItem(KEYBOARD_MODE_STORAGE_KEY, mode);
    } catch {
      // The current setting remains authoritative for this mounted surface.
    }
    if (showsDeckRef.current) {
      // The browser's keyboard is on its way out; nothing left of it should be able to fire.
      sawKeyboardViewport.current = false;
      setSoftwareKeyboardVisible(false);
      captureRef.current?.blur();
      return;
    }
    resetCapture();
    captureRef.current?.focus({ preventScroll: true });
  }, [deckAvailable, resetCapture]);

  const updatePresentation = useCallback((action: KeyboardPresentationAction) => {
    const previous = presentationRef.current;
    const next = keyboardPresentationReducer(previous, action);
    presentationRef.current = next;
    setPresentation(next);
    if (next !== previous) {
      report({
        phase: "keyboard-state",
        detail: {
          from: previous.presentation,
          to: next.presentation,
          focusRequestId: next.focusRequestId,
          secure: next.secure,
          cause: action.type,
        },
      });
    }
    return next;
  }, [report]);

  const clearFocusTimer = useCallback(() => {
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
    focusTimer.current = null;
  }, []);

  const clearLocalState = useCallback((action: "hide" | "transport-close", reason: string = action) => {
    if (presentationRef.current.presentation === "pending" || presentationRef.current.presentation === "shown") {
      report({ phase: "keyboard-state", detail: { event: "dismiss", reason } });
    }
    clearFocusTimer();
    pendingKeys.current = [];
    pendingDeliveries.current.clear();
    focusStarted.current = null;
    modifiersRef.current = OFF_MODIFIERS;
    setModifiers(OFF_MODIFIERS);
    setReceipt([]);
    setLocalEcho([]);
    setDeliveryStatus(null);
    composing.current = false;
    compositionCommitEcho.current = null;
    handledNativeInput.current = false;
    sawKeyboardViewport.current = false;
    setSoftwareKeyboardVisible(false);
    updatePresentation({ type: action });
    if (captureRef.current) {
      captureRef.current.value = "";
      captureRef.current.blur();
    }
  }, [clearFocusTimer, report, updatePresentation]);

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

  const sendControl = useCallback((input: DesktopControlInput): boolean => {
    const result = transportRef.current?.send(input) ?? "channel-closed";
    const accepted = result === "sent";
    if (!accepted) lastSendFailure.current = result;
    if (!accepted && input.type === "click" && input.focusRequestId) {
      report({
        phase: "keyboard-input-rejected",
        detail: { focusRequestId: input.focusRequestId, reason: result },
      });
      clearLocalState("hide", result);
    }
    return accepted;
  }, [clearLocalState, report]);

  const nextInputSequence = () => {
    const sequence = nextSequence.current;
    nextSequence.current = sequence === 0xffff_ffff ? 1 : sequence + 1;
    return sequence;
  };

  const sendBatch = useCallback((keys: RemoteKeyEvent[], secure: boolean): boolean => {
    const sequence = nextInputSequence();
    const input: DesktopControlInput = { type: "key-batch", sequence, keys };
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > DESKTOP_CONTROL_MAX_MESSAGE_BYTES) {
      setDeliveryStatus("Input not sent: batch exceeds control limit");
      report({
        phase: "keyboard-input-rejected",
        detail: { sequence, count: keys.length, reason: "oversized", secure },
      });
      return false;
    }
    pendingDeliveries.current.set(sequence, { tokens: keys.map((key) => receiptToken(key, secure)), secure });
    if (!sendControl(input)) {
      pendingDeliveries.current.delete(sequence);
      setDeliveryStatus("Input not sent: control channel unavailable");
      report({
        phase: "keyboard-input-rejected",
        detail: { sequence, count: keys.length, reason: lastSendFailure.current, secure },
      });
      return false;
    }
    setDeliveryStatus("Delivering…");
    return true;
  }, [report, sendControl]);

  /**
   * Send a whole string at once, as characters rather than as key presses.
   *
   * The per-keystroke path encodes each character as a US key position, and rejects the entire
   * insertion when one character has no such position: a pasted paragraph from a phone, where iOS
   * has already turned the quotes curly and the double hyphen into an em dash, fails as a whole.
   * This path carries the characters themselves, so what can be pasted is whatever Unicode has.
   *
   * It does not carry modifiers, which is the trade: a chord is still a key-batch.
   */
  const sendText = useCallback((text: string): boolean => {
    if (text.length === 0) return false;
    const secure = presentationRef.current.secure;
    const sequence = nextInputSequence();
    const input: DesktopControlInput = { type: "text", sequence, text };
    if (text.length > DESKTOP_CONTROL_MAX_TEXT_UNITS
        || new TextEncoder().encode(JSON.stringify(input)).byteLength > DESKTOP_CONTROL_MAX_MESSAGE_BYTES) {
      setDeliveryStatus("Text not sent: too long for one send");
      report({
        phase: "keyboard-input-rejected",
        detail: { sequence, count: text.length, reason: "oversized", secure },
      });
      return false;
    }
    // No receipt tokens: the echo strip mirrors keystrokes, and a paste is not keystrokes. Its
    // delivery is reported by the status line instead.
    pendingDeliveries.current.set(sequence, { tokens: [], secure });
    if (!sendControl(input)) {
      pendingDeliveries.current.delete(sequence);
      setDeliveryStatus("Text not sent: control channel unavailable");
      report({
        phase: "keyboard-input-rejected",
        detail: { sequence, count: text.length, reason: lastSendFailure.current, secure },
      });
      return false;
    }
    setDeliveryStatus("Delivering…");
    return true;
  }, [report, sendControl]);

  /**
   * Put the clipboard on the Mac without any field here taking focus.
   *
   * The obvious shape -- a text box you paste into -- cannot work in a browser tab. WebKit draws
   * its form-navigation strip whenever a field big enough to tap holds focus, that strip lands on
   * top of the panel's own key rail, and no web API removes it; the native containers suppress it
   * with `inputAccessoryView`, and a browser has no such lever. Reading the clipboard on a button
   * press needs no focused field, so the strip never appears. iOS answers the read with its own
   * paste confirmation, which is the platform's own privacy prompt and not something to route
   * around.
   */
  const pasteFromClipboard = useCallback(async (): Promise<void> => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.readText) {
      setDeliveryStatus("Paste unavailable: this browser will not read the clipboard");
      return;
    }
    let text: string;
    try {
      text = await clipboard.readText();
    } catch {
      // Denied, dismissed, or read outside the gesture. All three are the same to the viewer.
      setDeliveryStatus("Paste not allowed: nothing was read");
      return;
    }
    if (text.length === 0) {
      setDeliveryStatus("Clipboard is empty: nothing was sent");
      return;
    }
    // With the deck up there is a keyboard to edit with, so the paste lands in a draft and waits.
    // Without one there is nothing to edit it with, and it goes as it always did.
    if (showsDeckRef.current) {
      setDeliveryStatus(null);
      setDraft(text);
      return;
    }
    sendText(text);
  }, [sendText]);

  const appendToDraft = useCallback((character: string) => {
    setDraft((current) => (current === null ? current : current + character));
  }, []);

  const backspaceDraft = useCallback(() => {
    // By code point, so one backspace takes one emoji rather than half of one.
    setDraft((current) => (current === null ? current : [...current].slice(0, -1).join("")));
  }, []);

  const cancelDraft = useCallback(() => {
    setDraft(null);
    setDeliveryStatus(null);
  }, []);

  /** Commit the edited text and leave the mode. It goes as characters, which is what a paste is. */
  const sendDraft = useCallback(() => {
    const text = draftRef.current;
    if (text === null) return;
    setDraft(null);
    if (text.length === 0) return;
    sendText(text);
  }, [sendText]);

  const decorateWithStickyModifiers = useCallback((keys: RemoteKeyEvent[]): RemoteKeyEvent[] => {
    let states = modifiersRef.current;
    return keys.map((key) => {
      const next = { ...key, modifiers: activeModifiers(states, key.modifiers) };
      states = clearArmedModifiers(states);
      return next;
    });
  }, []);

  const acceptEncodedKeys = useCallback((keys: RemoteKeyEvent[]): boolean => {
    if (keys.length === 0) return true;
    if (keys.length > DESKTOP_CONTROL_MAX_KEY_BATCH) {
      setDeliveryStatus("Input not sent: insertion is too long");
      report({
        phase: "keyboard-input-rejected",
        detail: { count: keys.length, reason: "oversized" },
      });
      return false;
    }
    const state = presentationRef.current;
    if (state.presentation !== "pending" && state.presentation !== "shown") return false;
    if (state.presentation === "pending"
        && pendingKeys.current.length + keys.length > MAX_PENDING_KEY_EVENTS) {
      setDeliveryStatus("Input not sent: focus buffer full");
      report({
        phase: "keyboard-buffer-overflow",
        detail: {
          focusRequestId: state.focusRequestId,
          pendingCount: pendingKeys.current.length,
          rejectedCount: keys.length,
        },
      });
      return false;
    }
    const decorated = decorateWithStickyModifiers(keys);
    if (state.presentation === "pending") {
      pendingKeys.current.push(...decorated);
      setDeliveryStatus("Waiting for focus…");
    } else if (!sendBatch(decorated, state.secure || state.editability === null)) {
      return false;
    }
    const nextModifiers = clearArmedModifiers(modifiersRef.current);
    modifiersRef.current = nextModifiers;
    setModifiers(nextModifiers);
    setLocalEcho((current) => appendLocalEcho(current, decorated, state.secure || state.editability === null));
    return true;
  }, [decorateWithStickyModifiers, report, sendBatch]);

  const acceptText = useCallback((text: string): boolean => {
    const encoded = remoteKeysForText(text);
    if (!encoded) {
      setDeliveryStatus("Unsupported character: nothing was sent");
      report({
        phase: "keyboard-input-rejected",
        detail: { reason: "unknown-key", count: [...text].length },
      });
      return false;
    }
    return acceptEncodedKeys(encoded);
  }, [acceptEncodedKeys, report]);

  /**
   * One character from the on-screen deck.
   *
   * Most of them are a US key position and go as one, which is what carries the armed modifiers
   * and fills the echo strip. The symbols page also offers four that no US keyboard has a key for
   * -- the currency signs and the bullet -- and those go as characters instead, since a key code
   * that does not exist cannot be sent. Their echo is appended here because the text path
   * deliberately reports no keystroke tokens of its own.
   */
  const sendDeckCharacter = useCallback((character: string): boolean => {
    // A draft is a mode, so the deck types into it rather than at the Mac. Return is the exception
    // and the way out: it sends what has been edited.
    if (draftRef.current !== null) {
      if (character === "\n") {
        sendDraft();
        return true;
      }
      appendToDraft(character);
      return true;
    }
    const key = remoteKeyForCharacter(character);
    if (key) return acceptEncodedKeys([key]);
    const secure = presentationRef.current.secure || presentationRef.current.editability === null;
    if (!sendText(character)) return false;
    setLocalEcho((current) => [...current, secure ? "\u2022" : character].slice(-MAX_RECEIPT_EVENTS));
    return true;
  }, [acceptEncodedKeys, appendToDraft, sendDraft, sendText]);

  /** Panning the deck's space bar moves the remote caret, one arrow press per step. */
  const sendDeckCursorDelta = useCallback((delta: number) => {
    const code: RemoteKeyCode = delta > 0 ? "right" : "left";
    const steps = Math.min(Math.abs(delta), DESKTOP_CONTROL_MAX_KEY_BATCH);
    acceptEncodedKeys(Array.from({ length: steps }, () => ({ code, modifiers: [] })));
  }, [acceptEncodedKeys]);

  const hide = useCallback(() => clearLocalState("hide", "explicit-hide"), [clearLocalState]);

  const prepareCapture = useCallback(() => {
    const state = presentationRef.current.presentation;
    if (state !== "pending" && state !== "shown") {
      fullViewportHeight.current = window.visualViewport?.height ?? window.innerHeight;
      sawKeyboardViewport.current = false;
    }
    resetCapture();
    focusCapture();
  }, [focusCapture, resetCapture]);

  const beforeRemoteClick = useCallback((): string | undefined => {
    if (!autoKeyboard || !transportRef.current) return undefined;
    // Refusing here is the whole point: focusing to find out costs a visible show-and-hide of the
    // iOS keyboard on every tap that was never going to type. Without a request id the click still
    // goes to the Mac, the helper never probes, and nothing on this surface moves.
    const kind = cursorKind();
    if (!shouldPrimeKeyboard(kind)) {
      // Reported under `keyboard-state` rather than a phase of its own: the sidecar's telemetry
      // allowlist is a closed contract, and a refusal to change presentation is a presentation
      // record like any other.
      report({ phase: "keyboard-state", detail: { event: "prime-skipped", cursorKind: kind } });
      return undefined;
    }
    const focusRequestId = crypto.randomUUID();
    clearFocusTimer();
    pendingKeys.current = [];
    setLocalEcho([]);
    prepareCapture();
    updatePresentation({ type: "remote-tap", focusRequestId });
    focusStarted.current = { requestID: focusRequestId, at: performance.now() };
    focusTimer.current = window.setTimeout(() => {
      if (presentationRef.current.focusRequestId !== focusRequestId) return;
      focusTimer.current = null;
      const started = focusStarted.current?.requestID === focusRequestId
        ? focusStarted.current.at
        : null;
      focusStarted.current = null;
      report({
        phase: "keyboard-focus-result",
        detail: {
          focusRequestId,
          result: "timeout",
          latencyMs: started === null ? KEYBOARD_FOCUS_TIMEOUT_MS : Math.round(performance.now() - started),
        },
      });
      clearLocalState("hide", "focus-timeout");
    }, KEYBOARD_FOCUS_TIMEOUT_MS);
    return focusRequestId;
  }, [autoKeyboard, clearFocusTimer, clearLocalState, cursorKind, prepareCapture, report, updatePresentation]);

  const consumePointerGesture = useCallback(() => {
    if (presentationRef.current.presentation !== "shown") return false;
    clearLocalState("hide", "tile-gesture");
    return true;
  }, [clearLocalState]);

  const showManually = useCallback(() => {
    if (!transportRef.current) return;
    clearFocusTimer();
    pendingKeys.current = [];
    setLocalEcho([]);
    const focusRequestId = crypto.randomUUID();
    prepareCapture();
    updatePresentation({ type: "manual-show", focusRequestId });
    focusStarted.current = { requestID: focusRequestId, at: performance.now() };
    if (!sendControl({ type: "focus-query", focusRequestId })) hide();
  }, [clearFocusTimer, hide, prepareCapture, sendControl, updatePresentation]);

  const sendChromeKey = useCallback((code: RemoteKeyCode) => {
    acceptEncodedKeys([{ code, modifiers: [] }]);
    focusCapture();
  }, [acceptEncodedKeys, focusCapture]);

  /** Backspace edits the draft while there is one, and reaches the Mac only when there is not. */
  const deckBackspace = useCallback(() => {
    if (draftRef.current !== null) {
      backspaceDraft();
      return;
    }
    sendChromeKey("delete");
  }, [backspaceDraft, sendChromeKey]);

  const tapModifier = useCallback((modifier: RemoteModifier) => {
    const next = { ...modifiersRef.current };
    next[modifier] = cycleModifier(next[modifier]);
    modifiersRef.current = next;
    setModifiers(next);
    focusCapture();
  }, [focusCapture]);

  const setAutoKeyboard = useCallback((enabled: boolean) => {
    setAutoKeyboardState(enabled);
    try {
      window.localStorage.setItem(AUTO_KEYBOARD_STORAGE_KEY, String(enabled));
    } catch {
      // The current setting remains authoritative for this mounted surface.
    }
  }, []);

  const handleControlEvent = useCallback((event: DesktopControlEvent) => {
    if (event.type === "control-revoked") {
      report({ phase: "control-ownership", detail: { state: "revoked", epoch: event.epoch } });
      clearLocalState("hide", "control-revoked");
      return;
    }
    if (event.type === "control-granted") {
      report({ phase: "control-ownership", detail: { state: "granted", epoch: event.epoch } });
      return;
    }
    if (event.type === "text-focus") {
      if (presentationRef.current.focusRequestId !== event.focusRequestId) return;
      clearFocusTimer();
      const started = focusStarted.current?.requestID === event.focusRequestId
        ? focusStarted.current.at
        : null;
      focusStarted.current = null;
      const before = presentationRef.current.presentation;
      const next = updatePresentation({ type: "focus-result", event });
      report({
        phase: "keyboard-focus-result",
        detail: {
          focusRequestId: event.focusRequestId,
          editability: event.editability,
          source: event.source,
          secure: event.secure,
          cursorKind: event.cursorKind,
          latencyMs: started === null ? undefined : Math.round(performance.now() - started),
        },
      });
      if (before === "pending" && next.presentation === "shown") {
        const keys = pendingKeys.current;
        pendingKeys.current = [];
        if (keys.length > 0) {
          if (sendBatch(keys, event.secure)) setLocalEcho(appendLocalEcho([], keys, event.secure));
          else setLocalEcho([]);
        }
      } else if (next.presentation === "hidden") {
        clearLocalState("hide", "non-editable-focus");
      }
      return;
    }
    if (event.type === "input-applied") {
      const delivery = pendingDeliveries.current.get(event.sequence);
      if (!delivery) return;
      pendingDeliveries.current.delete(event.sequence);
      setReceipt((current) => [...current, ...delivery.tokens].slice(-MAX_RECEIPT_EVENTS));
      setDeliveryStatus(pendingDeliveries.current.size > 0 ? "Delivering…" : "Delivered");
      report({
        phase: "keyboard-input-applied",
        detail: { sequence: event.sequence, count: delivery.tokens.length, secure: delivery.secure },
      });
      return;
    }
    if (event.type === "input-rejected") {
      const delivery = event.sequence === undefined
        ? undefined
        : pendingDeliveries.current.get(event.sequence);
      if (event.sequence !== undefined) pendingDeliveries.current.delete(event.sequence);
      setLocalEcho([]);
      setDeliveryStatus(`Input rejected: ${event.reason}`);
      report({
        phase: "keyboard-input-rejected",
        detail: {
          sequence: event.sequence,
          count: delivery?.tokens.length,
          reason: event.reason,
          secure: delivery?.secure ?? presentationRef.current.secure,
        },
      });
      if (presentationRef.current.presentation === "pending"
          || event.reason === "accessibility-denied"
          || event.reason === "not-owner") {
        clearLocalState("hide", event.reason);
      }
    }
  }, [clearFocusTimer, clearLocalState, report, sendBatch, updatePresentation]);

  const onBeforeInput = useCallback((input: InputEvent) => {
    handledNativeInput.current = false;
    if (compositionCommitEcho.current !== null && input.data === compositionCommitEcho.current) {
      compositionCommitEcho.current = null;
      input.preventDefault();
      handledNativeInput.current = !input.cancelable;
      resetCapture();
      return;
    }
    if (composing.current || input.isComposing || input.inputType === "insertCompositionText") return;
    let recognized = false;
    if (input.inputType === "deleteContentBackward") {
      recognized = true;
      acceptEncodedKeys([{ code: "delete", modifiers: [] }]);
    } else if (input.inputType === "insertLineBreak" || input.inputType === "insertParagraph") {
      recognized = true;
      acceptEncodedKeys([{ code: "return", modifiers: [] }]);
    } else if (typeof input.data === "string" && input.data.length > 0) {
      recognized = true;
      acceptText(input.data);
    }
    if (recognized) {
      input.preventDefault();
      handledNativeInput.current = !input.cancelable;
      resetCapture();
    }
  }, [acceptEncodedKeys, acceptText, resetCapture]);

  // React 19 polyfills onBeforeInput from textInput/keypress and misses native deletes.
  useEffect(() => {
    const capture = captureRef.current;
    capture?.addEventListener("beforeinput", onBeforeInput);
    return () => capture?.removeEventListener("beforeinput", onBeforeInput);
  }, [onBeforeInput]);

  const onInput = useCallback((event: FormEvent<HTMLTextAreaElement>) => {
    if (composing.current) return;
    const input = event.nativeEvent as InputEvent;
    const text = event.currentTarget.value.replace(/^\u200b/, "");
    resetCapture();
    if (handledNativeInput.current) {
      handledNativeInput.current = false;
      return;
    }
    if (compositionCommitEcho.current !== null && text === compositionCommitEcho.current) {
      compositionCommitEcho.current = null;
      return;
    }
    if (input.inputType === "deleteContentBackward") acceptEncodedKeys([{ code: "delete", modifiers: [] }]);
    else if (input.inputType === "insertLineBreak" || input.inputType === "insertParagraph") {
      acceptEncodedKeys([{ code: "return", modifiers: [] }]);
    } else if (text) acceptText(text);
  }, [acceptEncodedKeys, acceptText, resetCapture]);

  /**
   * A paste goes as characters, not as key presses.
   *
   * Typing one character at a time can encode it as a US key position and carry modifiers with it.
   * A paste can do neither usefully: it has no modifiers, and iOS has already turned the quotes
   * curly and the double hyphen into an em dash before the clipboard is read, so the key-position
   * encoder refuses the whole insertion. Sending the string itself is the only route that works,
   * and it is also the only one that can carry an emoji or a non-Latin script.
   */
  const onPaste = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    sendText(event.clipboardData.getData("text/plain"));
    resetCapture();
  }, [resetCapture, sendText]);

  const onCompositionStart = useCallback(() => {
    composing.current = true;
  }, []);

  const onCompositionEnd = useCallback((event: ReactCompositionEvent<HTMLTextAreaElement>) => {
    composing.current = false;
    resetCapture();
    if (event.data) {
      compositionCommitEcho.current = event.data;
      window.setTimeout(() => { compositionCommitEcho.current = null; }, 0);
      acceptText(event.data);
    }
  }, [acceptText, resetCapture]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const controls: Partial<Record<string, RemoteKeyCode>> = {
      Escape: "escape", Tab: "tab", ArrowLeft: "left", ArrowRight: "right",
      ArrowUp: "up", ArrowDown: "down", Backspace: "delete", Enter: "return",
    };
    let key = controls[event.key]
      ? { code: controls[event.key]!, modifiers: [] as RemoteModifier[] }
      : null;
    if (!key && event.key.length === 1 && (event.metaKey || event.ctrlKey || event.altKey)) {
      key = remoteKeyForCharacter(event.key);
    }
    if (!key) return;
    const physical: RemoteModifier[] = [];
    if (event.metaKey) physical.push("cmd");
    if (event.ctrlKey) physical.push("ctrl");
    if (event.altKey) physical.push("option");
    if (event.shiftKey) physical.push("shift");
    key.modifiers = REMOTE_MODIFIER_ORDER.filter((modifier) => (
      physical.includes(modifier) || key!.modifiers.includes(modifier)
    ));
    event.preventDefault();
    event.stopPropagation();
    acceptEncodedKeys([key]);
  }, [acceptEncodedKeys]);

  /**
   * Losing focus means the browser's keyboard went away, so stop presenting -- but only while the
   * browser's keyboard is the one typing. With the deck, an unfocused capture is the resting
   * state, and the blur that comes from switching back to it is not a dismissal.
   */
  const onBlur = useCallback(() => {
    if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
    blurTimer.current = window.setTimeout(() => {
      blurTimer.current = null;
      if (showsDeckRef.current) return;
      if (document.activeElement !== captureRef.current
          && (presentationRef.current.presentation === "shown"
            || presentationRef.current.presentation === "pending")) clearLocalState("hide", "dom-blur");
    }, 0);
  }, [clearLocalState]);

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
