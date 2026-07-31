"use client";

import { Mic2 } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SYSTEM_DEFAULT_MICROPHONE,
  useMicrophoneSelection,
} from "@/features/voice/microphone-selection";

export function MicrophoneSelector({ disabled }: { readonly disabled: boolean }) {
  const { view, select } = useMicrophoneSelection();
  const ready = view.status === "ready";
  const items = [
    { value: SYSTEM_DEFAULT_MICROPHONE, label: "System default" },
    ...(ready
      ? view.devices.map((device) => ({
          value: device.deviceId,
          label: device.label,
        }))
      : []),
  ];

  return (
    <div className="flex min-w-56 flex-col gap-1.5">
      <span
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
        id="voice-microphone-label"
      >
        <Mic2 className="size-3.5" />
        Microphone
      </span>
      <Select
        disabled={disabled || !ready}
        items={items}
        value={view.selected}
        onValueChange={(value) => {
          if (typeof value === "string") select(value);
        }}
      >
        <SelectTrigger
          aria-labelledby="voice-microphone-label"
          className="w-full max-w-80"
        >
          <SelectValue placeholder="Choose a microphone" />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {ready && view.notice ? (
        <span className="text-[11px] text-muted-foreground" role="status">
          {view.notice}
        </span>
      ) : ready && view.devices.length === 0 ? (
        <span className="text-[11px] text-muted-foreground">
          More inputs appear after microphone access is granted.
        </span>
      ) : null}
      {view.status === "error" || view.status === "unavailable" ? (
        <span className="text-[11px] text-destructive">{view.message}</span>
      ) : null}
    </div>
  );
}
