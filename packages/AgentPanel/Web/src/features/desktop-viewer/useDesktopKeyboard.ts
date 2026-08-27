import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type CompositionEvent as ReactCompositionEvent,
} from "react";
import type {
  DesktopControlEvent,
  DesktopControlInput,
  RemoteKeyCode,
  RemoteKeyEvent,
  RemoteModifier,
} from "@agentdesk/agent-feed-wire";
import {
  DESKTOP_CONTROL_MAX_KEY_BATCH,
  DESKTOP_CONTROL_MAX_MESSAGE_BYTES,
} from "@agentdesk/agent-feed-wire";
import type { DesktopControlTransport } from "./TileStreamRtc";
import {
  activeModifiers,
  clearArmedModifiers,
  cycleModifier,
  INITIAL_KEYBOARD_PRESENTATION,
  keyboardPresentationReducer,
  KEYBOARD_FOCUS_TIMEOUT_MS,
  MAX_PENDING_KEY_EVENTS,
  MAX_RECEIPT_EVENTS,
  receiptToken,
  REMOTE_MODIFIER_ORDER,
  remoteKeyForCharacter,
  remoteKeysForText,
  type KeyboardPresentationAction,
  type KeyboardPresentationState,
  type ModifierState,
} from "./desktopKeyboardModel";

const AUTO_KEYBOARD_STORAGE_KEY = "agentdesk.desktop-keyboard-auto.v2";
const OFF_MODIFIERS: Record<RemoteModifier, ModifierState> = {
  cmd: "off", ctrl: "off", option: "off", shift: "off",
};

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
  keys: RemoteKeyEvent[];
  secure: boolean;
}

export function useDesktopKeyboard({
  transport,
  report,
}: {
  transport: DesktopControlTransport | null;
  report: (event: DesktopKeyboardTelemetry) => void;
}) {
  const captureRef = useRef<HTMLTextAreaElement>(null);
  const transportRef = useRef(transport);
  const presentationRef = useRef<KeyboardPresentationState>(INITIAL_KEYBOARD_PRESENTATION);
  const [presentation, setPresentation] = useState(INITIAL_KEYBOARD_PRESENTATION);
  const [autoKeyboard, setAutoKeyboardState] = useState(storedAutoKeyboard);
  const [modifiers, setModifiers] = useState<Record<RemoteModifier, ModifierState>>(OFF_MODIFIERS);
  const modifiersRef = useRef(modifiers);
  const [receipt, setReceipt] = useState<string[]>([]);
  const [deliveryStatus, setDeliveryStatus] = useState<string | null>(null);
  const [accessoryBottom, setAccessoryBottom] = useState(0);
  const pendingKeys = useRef<RemoteKeyEvent[]>([]);
  const pendingDeliveries = useRef(new Map<number, PendingDelivery>());
  const nextSequence = useRef(1);
  const focusTimer = useRef<number | null>(null);
  const lastSendFailure = useRef<"channel-closed" | "backpressured">("channel-closed");
  const focusStarted = useRef<{ requestID: string; at: number } | null>(null);
  const composing = useRef(false);
  const compositionCommitEcho = useRef<string | null>(null);
  const sawKeyboardViewport = useRef(false);

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
        },
      });
    }
    return next;
  }, [report]);

  const clearFocusTimer = useCallback(() => {
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
    focusTimer.current = null;
  }, []);

  const clearLocalState = useCallback((action: "hide" | "transport-close") => {
    clearFocusTimer();
    pendingKeys.current = [];
    pendingDeliveries.current.clear();
    focusStarted.current = null;
    modifiersRef.current = OFF_MODIFIERS;
    setModifiers(OFF_MODIFIERS);
    setReceipt([]);
    setDeliveryStatus(null);
    if (captureRef.current) {
      captureRef.current.value = "";
      captureRef.current.blur();
    }
    updatePresentation({ type: action });
  }, [clearFocusTimer, updatePresentation]);

  useEffect(() => {
    transportRef.current = transport;
    if (transport) {
      updatePresentation({ type: "transport-open" });
    } else {
      clearLocalState("transport-close");
    }
  }, [clearLocalState, transport, updatePresentation]);

  useEffect(() => () => clearFocusTimer(), [clearFocusTimer]);

  const sendControl = useCallback((input: DesktopControlInput): boolean => {
    const result = transportRef.current?.send(input) ?? "channel-closed";
    const accepted = result === "sent";
    if (!accepted) lastSendFailure.current = result;
    if (!accepted && input.type === "click" && input.focusRequestId) {
      report({
        phase: "keyboard-input-rejected",
        detail: { focusRequestId: input.focusRequestId, reason: result },
      });
      clearLocalState("hide");
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
    pendingDeliveries.current.set(sequence, { keys, secure });
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

  const decorateWithStickyModifiers = useCallback((keys: RemoteKeyEvent[]): RemoteKeyEvent[] => {
    let states = modifiersRef.current;
    const decorated = keys.map((key) => {
      const next = { ...key, modifiers: activeModifiers(states, key.modifiers) };
      states = clearArmedModifiers(states);
      return next;
    });
    modifiersRef.current = states;
    setModifiers(states);
    return decorated;
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
      return true;
    }
    return sendBatch(decorated, state.secure);
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

  const hide = useCallback(() => clearLocalState("hide"), [clearLocalState]);

  const beforeRemoteClick = useCallback((): string | undefined => {
    if (!autoKeyboard || !transportRef.current) return undefined;
    const focusRequestId = crypto.randomUUID();
    clearFocusTimer();
    pendingKeys.current = [];
    updatePresentation({ type: "remote-tap", focusRequestId });
    focusStarted.current = { requestID: focusRequestId, at: performance.now() };
    captureRef.current?.focus({ preventScroll: true });
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
      pendingKeys.current = [];
      captureRef.current?.blur();
      updatePresentation({ type: "focus-timeout", focusRequestId });
    }, KEYBOARD_FOCUS_TIMEOUT_MS);
    return focusRequestId;
  }, [autoKeyboard, clearFocusTimer, report, updatePresentation]);

  const consumePointerGesture = useCallback(() => {
    if (presentationRef.current.presentation !== "shown") return false;
    hide();
    return true;
  }, [hide]);

  const showManually = useCallback(() => {
    if (!transportRef.current) return;
    const focusRequestId = crypto.randomUUID();
    captureRef.current?.focus({ preventScroll: true });
    updatePresentation({ type: "manual-show", focusRequestId });
    focusStarted.current = { requestID: focusRequestId, at: performance.now() };
    if (!sendControl({ type: "focus-query", focusRequestId })) hide();
  }, [hide, sendControl, updatePresentation]);

  const sendChromeKey = useCallback((code: RemoteKeyCode) => {
    acceptEncodedKeys([{ code, modifiers: [] }]);
    captureRef.current?.focus({ preventScroll: true });
  }, [acceptEncodedKeys]);

  const tapModifier = useCallback((modifier: RemoteModifier) => {
    const next = { ...modifiersRef.current };
    next[modifier] = cycleModifier(next[modifier]);
    modifiersRef.current = next;
    setModifiers(next);
    captureRef.current?.focus({ preventScroll: true });
  }, []);

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
      clearLocalState("hide");
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
        if (keys.length > 0) sendBatch(keys, event.secure);
      } else if (next.presentation === "hidden") {
        pendingKeys.current = [];
        captureRef.current?.blur();
      }
      return;
    }
    if (event.type === "input-applied") {
      const delivery = pendingDeliveries.current.get(event.sequence);
      if (!delivery) return;
      pendingDeliveries.current.delete(event.sequence);
      const tokens = delivery.keys.map((key) => receiptToken(key, delivery.secure));
      setReceipt((current) => [...current, ...tokens].slice(-MAX_RECEIPT_EVENTS));
      setDeliveryStatus("Delivered");
      report({
        phase: "keyboard-input-applied",
        detail: { sequence: event.sequence, count: delivery.keys.length, secure: delivery.secure },
      });
      return;
    }
    if (event.type === "input-rejected") {
      const delivery = event.sequence === undefined
        ? undefined
        : pendingDeliveries.current.get(event.sequence);
      if (event.sequence !== undefined) pendingDeliveries.current.delete(event.sequence);
      setDeliveryStatus(`Input rejected: ${event.reason}`);
      report({
        phase: "keyboard-input-rejected",
        detail: {
          sequence: event.sequence,
          count: delivery?.keys.length,
          reason: event.reason,
          secure: delivery?.secure ?? presentationRef.current.secure,
        },
      });
      if (presentationRef.current.presentation === "pending"
          || event.reason === "accessibility-denied"
          || event.reason === "not-owner") {
        clearLocalState("hide");
      }
    }
  }, [clearFocusTimer, clearLocalState, report, sendBatch, updatePresentation]);

  const onBeforeInput = useCallback((event: FormEvent<HTMLTextAreaElement>) => {
    const input = event.nativeEvent as InputEvent;
    if (compositionCommitEcho.current !== null && input.data === compositionCommitEcho.current) {
      compositionCommitEcho.current = null;
      event.preventDefault();
      event.currentTarget.value = "";
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
    if (recognized) event.preventDefault();
    event.currentTarget.value = "";
  }, [acceptEncodedKeys, acceptText]);

  const onInput = useCallback((event: FormEvent<HTMLTextAreaElement>) => {
    if (composing.current) return;
    const text = event.currentTarget.value;
    event.currentTarget.value = "";
    if (compositionCommitEcho.current !== null && text === compositionCommitEcho.current) {
      compositionCommitEcho.current = null;
      return;
    }
    if (text) acceptText(text);
  }, [acceptText]);

  const onCompositionStart = useCallback(() => {
    composing.current = true;
  }, []);

  const onCompositionEnd = useCallback((event: ReactCompositionEvent<HTMLTextAreaElement>) => {
    composing.current = false;
    event.currentTarget.value = "";
    if (event.data) {
      compositionCommitEcho.current = event.data;
      window.setTimeout(() => { compositionCommitEcho.current = null; }, 0);
      acceptText(event.data);
    }
  }, [acceptText]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const controls: Partial<Record<string, RemoteKeyCode>> = {
      Escape: "escape", Tab: "tab", ArrowLeft: "left", ArrowRight: "right",
      ArrowUp: "up", ArrowDown: "down",
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
    if (acceptEncodedKeys([key])) event.preventDefault();
  }, [acceptEncodedKeys]);

  const onBlur = useCallback(() => {
    window.setTimeout(() => {
      if (document.activeElement !== captureRef.current
          && presentationRef.current.presentation === "shown") hide();
    }, 0);
  }, [hide]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const update = () => {
      const bottom = Math.max(0, window.innerHeight - (viewport.offsetTop + viewport.height));
      setAccessoryBottom(bottom);
      if (viewport.height < window.innerHeight - 80) sawKeyboardViewport.current = true;
      if (sawKeyboardViewport.current
          && viewport.height >= window.innerHeight - 24
          && presentationRef.current.presentation === "shown") {
        sawKeyboardViewport.current = false;
        hide();
      }
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [hide]);

  return {
    captureRef,
    presentation,
    keyboardPresented: presentation.presentation === "pending" || presentation.presentation === "shown",
    autoKeyboard,
    modifiers,
    receipt,
    deliveryStatus,
    accessoryBottom,
    sendControl,
    handleControlEvent,
    beforeRemoteClick,
    consumePointerGesture,
    showManually,
    hide,
    sendChromeKey,
    tapModifier,
    setAutoKeyboard,
    captureProps: {
      onBeforeInput,
      onInput,
      onCompositionStart,
      onCompositionEnd,
      onKeyDown,
      onBlur,
    },
  };
}
