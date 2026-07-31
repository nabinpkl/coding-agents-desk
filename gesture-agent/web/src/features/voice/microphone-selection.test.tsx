/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  persistMicrophoneSelection,
  selectedMicrophoneDeviceID,
  SYSTEM_DEFAULT_MICROPHONE,
  useMicrophoneSelection,
} from "@/features/voice/microphone-selection";

function device(
  kind: MediaDeviceKind,
  deviceId: string,
  label: string,
): MediaDeviceInfo {
  return {
    kind,
    deviceId,
    label,
    groupId: "group",
    toJSON: () => ({}),
  };
}

const enumerateDevices = vi.fn();
const addEventListener = vi.fn();
const removeEventListener = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  enumerateDevices.mockResolvedValue([
    device("audioinput", "default", "Default"),
    device("audioinput", "mic-one", ""),
    device("videoinput", "camera", "Camera"),
    device("audioinput", "mic-two", "Studio microphone"),
  ]);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices, addEventListener, removeEventListener },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("microphone selection", () => {
  it("persists an explicit device and removes it for system default", () => {
    persistMicrophoneSelection("mic-two");
    expect(selectedMicrophoneDeviceID()).toBe("mic-two");

    persistMicrophoneSelection(SYSTEM_DEFAULT_MICROPHONE);
    expect(selectedMicrophoneDeviceID()).toBeUndefined();
  });

  it("lists selectable audio inputs and persists the user's choice", async () => {
    const { result } = renderHook(() => useMicrophoneSelection());

    await waitFor(() => expect(result.current.view.status).toBe("ready"));
    expect(result.current.view).toMatchObject({
      selected: SYSTEM_DEFAULT_MICROPHONE,
      devices: [
        { deviceId: "mic-one", label: "Microphone 1" },
        { deviceId: "mic-two", label: "Studio microphone" },
      ],
    });

    act(() => result.current.select("mic-two"));
    expect(result.current.view.selected).toBe("mic-two");
    expect(selectedMicrophoneDeviceID()).toBe("mic-two");
  });

  it("returns to system default when a saved microphone disappears", async () => {
    persistMicrophoneSelection("missing-mic");
    const { result } = renderHook(() => useMicrophoneSelection());

    await waitFor(() => expect(result.current.view.status).toBe("ready"));
    expect(result.current.view.selected).toBe(SYSTEM_DEFAULT_MICROPHONE);
    expect(result.current.view).toMatchObject({
      notice: "The saved microphone is disconnected. Using system default.",
    });
    expect(selectedMicrophoneDeviceID()).toBeUndefined();
  });
});
