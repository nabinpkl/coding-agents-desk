"use client";

/**
 * A dumb picker over saved recordings. Displays the recording label + caption
 * and reports the chosen id upward. Optionally hides one id (used to keep the
 * reference and learner selectors from colliding on the same take).
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Recording } from "@/lib/wire";

import { recordingCaption, recordingLabel } from "../format";

export interface RecordingSelectProps {
  recordings: Recording[];
  value: string | null;
  onChange: (recordingId: string) => void;
  placeholder?: string;
  excludeId?: string | null;
  disabled?: boolean;
}

export function RecordingSelect({
  recordings,
  value,
  onChange,
  placeholder = "Select a recording",
  excludeId = null,
  disabled = false,
}: RecordingSelectProps) {
  const options = recordings.filter((recording) => recording.id !== excludeId);
  const items = options.map((recording) => ({
    value: recording.id,
    label: recordingLabel(recording),
  }));

  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
      disabled={disabled || options.length === 0}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((recording) => (
          <SelectItem key={recording.id} value={recording.id}>
            <span className="flex flex-col gap-0.5">
              <span className="truncate">{recordingLabel(recording)}</span>
              <span className="text-xs text-muted-foreground">
                {recordingCaption(recording)}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
