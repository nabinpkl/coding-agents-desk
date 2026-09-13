// Everything the keyboard's parts read and write, handed over as one object.
//
// The hook owns the refs and the state setters; the parts below are free functions that
// take them. That is what lets "putting input on the wire", "the hidden capture field"
// and "what the Mac answers" be three files rather than one nine-hundred-line closure,
// without any of them owning a second copy of the state the others read.

import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  DesktopControlInput,
  DesktopCursorKind,
  RemoteKeyEvent,
  RemoteModifier,
} from "@agentdesk/agent-feed-wire";
import type { DesktopControlTransport } from "../tile-stream/TileStreamRtc";
import type {
  KeyboardPresentationState,
  ModifierState,
} from "./desktopKeyboardModel";

export type KeyboardMode = "deck" | "native";

export interface DesktopKeyboardTelemetry {
  phase: string;
  detail: Record<string, unknown>;
}

/** One key batch in flight, and the receipt tokens that will acknowledge it. */
export interface PendingDelivery {
  tokens: string[];
  secure: boolean;
}

export interface KeyboardContext {
  readonly captureRef: RefObject<HTMLTextAreaElement | null>;
  readonly transportRef: RefObject<DesktopControlTransport | null>;
  readonly presentationRef: RefObject<KeyboardPresentationState>;
  readonly showsDeckRef: RefObject<boolean>;
  readonly modifiersRef: RefObject<Record<RemoteModifier, ModifierState>>;
  readonly draftRef: RefObject<string | null>;
  readonly accessoryRef: RefObject<HTMLElement | null>;
  readonly pendingKeys: RefObject<RemoteKeyEvent[]>;
  readonly pendingDeliveries: RefObject<Map<number, PendingDelivery>>;
  readonly nextSequence: RefObject<number>;
  readonly focusTimer: RefObject<number | null>;
  readonly lastSendFailure: RefObject<"channel-closed" | "backpressured">;
  readonly focusStarted: RefObject<{ requestID: string; at: number } | null>;
  readonly composing: RefObject<boolean>;
  readonly compositionCommitEcho: RefObject<string | null>;
  readonly sawKeyboardViewport: RefObject<boolean>;
  readonly fullViewportHeight: RefObject<number>;
  readonly handledNativeInput: RefObject<boolean>;
  readonly blurTimer: RefObject<number | null>;
  readonly setPresentation: Dispatch<SetStateAction<KeyboardPresentationState>>;
  readonly setAutoKeyboardState: Dispatch<SetStateAction<boolean>>;
  readonly setKeyboardModeState: Dispatch<SetStateAction<KeyboardMode>>;
  readonly setModifiers: Dispatch<SetStateAction<Record<RemoteModifier, ModifierState>>>;
  readonly setReceipt: Dispatch<SetStateAction<string[]>>;
  readonly setLocalEcho: Dispatch<SetStateAction<string[]>>;
  readonly setDeliveryStatus: Dispatch<SetStateAction<string | null>>;
  readonly setDraft: Dispatch<SetStateAction<string | null>>;
  readonly setAccessoryBottom: Dispatch<SetStateAction<number>>;
  readonly setAccessoryHeight: Dispatch<SetStateAction<number>>;
  readonly setSoftwareKeyboardVisible: Dispatch<SetStateAction<boolean>>;
  readonly report: (event: DesktopKeyboardTelemetry) => void;
  readonly cursorKind: () => DesktopCursorKind;
  readonly deckAvailable: boolean;
  /** Whether a tap on editable text is allowed to raise the keyboard by itself. */
  readonly autoKeyboard: boolean;
}

/** A control input, and whether the channel took it. */
export type SendControl = (input: DesktopControlInput) => boolean;
