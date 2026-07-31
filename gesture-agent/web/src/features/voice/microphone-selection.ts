/**
 * Browser microphone discovery and the device preference shared by every web
 * voice capture surface. The preference is device-local UI state, while each
 * capture still owns and releases its own MediaStream.
 */

"use client";

import { useEffect, useState } from "react";

const MICROPHONE_DEVICE_ID_KEY = "agentDesk.voice.microphoneDeviceId";
const MICROPHONE_ACCESS_EVENT = "agentdesk:microphone-access-granted";

export const SYSTEM_DEFAULT_MICROPHONE = "system-default";

export interface MicrophoneInputDevice {
  readonly deviceId: string;
  readonly label: string;
}

export type MicrophoneSelectionView =
  | { readonly status: "loading"; readonly selected: string }
  | {
      readonly status: "ready";
      readonly selected: string;
      readonly devices: readonly MicrophoneInputDevice[];
      readonly notice?: string;
    }
  | {
      readonly status: "unavailable" | "error";
      readonly selected: string;
      readonly message: string;
    };

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function selectedMicrophoneDeviceID(): string | undefined {
  return browserStorage()?.getItem(MICROPHONE_DEVICE_ID_KEY) || undefined;
}

export function persistMicrophoneSelection(selection: string): void {
  const storage = browserStorage();
  if (!storage) return;
  if (selection === SYSTEM_DEFAULT_MICROPHONE) {
    storage.removeItem(MICROPHONE_DEVICE_ID_KEY);
    return;
  }
  if (!selection) {
    throw new Error("Microphone selection cannot be empty.");
  }
  storage.setItem(MICROPHONE_DEVICE_ID_KEY, selection);
}

export function notifyMicrophoneAccessGranted(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(MICROPHONE_ACCESS_EVENT));
  }
}

function storedSelection(): string {
  return selectedMicrophoneDeviceID() ?? SYSTEM_DEFAULT_MICROPHONE;
}

function namedAudioInputs(devices: readonly MediaDeviceInfo[]): MicrophoneInputDevice[] {
  const seen = new Set<string>();
  const inputs: MicrophoneInputDevice[] = [];
  for (const device of devices) {
    if (
      device.kind !== "audioinput" ||
      !device.deviceId ||
      device.deviceId === "default" ||
      device.deviceId === "communications" ||
      seen.has(device.deviceId)
    ) {
      continue;
    }
    seen.add(device.deviceId);
    inputs.push({
      deviceId: device.deviceId,
      label: device.label.trim() || `Microphone ${inputs.length + 1}`,
    });
  }
  return inputs;
}

export function useMicrophoneSelection(): {
  readonly view: MicrophoneSelectionView;
  readonly select: (selection: string) => void;
} {
  const [view, setView] = useState<MicrophoneSelectionView>({
    status: "loading",
    selected: SYSTEM_DEFAULT_MICROPHONE,
  });

  useEffect(() => {
    let active = true;
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) {
      queueMicrotask(() => {
        if (!active) return;
        setView({
          status: "unavailable",
          selected: storedSelection(),
          message: "Microphone selection is not available in this browser.",
        });
      });
      return () => {
        active = false;
      };
    }

    const refresh = async () => {
      try {
        const devices = namedAudioInputs(await mediaDevices.enumerateDevices());
        if (!active) return;
        let selected = storedSelection();
        let notice: string | undefined;
        if (
          selected !== SYSTEM_DEFAULT_MICROPHONE &&
          !devices.some((device) => device.deviceId === selected)
        ) {
          persistMicrophoneSelection(SYSTEM_DEFAULT_MICROPHONE);
          selected = SYSTEM_DEFAULT_MICROPHONE;
          notice = "The saved microphone is disconnected. Using system default.";
        }
        setView({ status: "ready", selected, devices, notice });
      } catch (error) {
        if (!active) return;
        setView({
          status: "error",
          selected: storedSelection(),
          message:
            error instanceof Error
              ? error.message
              : "Microphone devices could not be listed.",
        });
      }
    };

    const refreshDevices = () => void refresh();
    void refresh();
    mediaDevices.addEventListener("devicechange", refreshDevices);
    window.addEventListener(MICROPHONE_ACCESS_EVENT, refreshDevices);
    return () => {
      active = false;
      mediaDevices.removeEventListener("devicechange", refreshDevices);
      window.removeEventListener(MICROPHONE_ACCESS_EVENT, refreshDevices);
    };
  }, []);

  function select(selection: string): void {
    persistMicrophoneSelection(selection);
    setView((current) => ({ ...current, selected: selection }));
  }

  return { view, select };
}
