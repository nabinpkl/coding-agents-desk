/**
 * Truth view: the persisted recordings from the TanStack Query cache. It reads
 * `useRecordings` and renders loading / error / empty / list states. It holds
 * no momentum and never reaches into the voice store. The server returns the
 * list newest-first; this view does not re-sort it.
 */

"use client";

import { AlertCircle, ListMusic, Loader2, Trash2 } from "lucide-react";

import { useDeleteRecording, useRecordings } from "@/features/voice/use-recordings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { recordingAudioUrl } from "@/lib/api";
import type { Recording } from "@/lib/wire";

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function formatCreatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function RecordingRow({
  recording,
  onDelete,
  isDeleting,
}: {
  readonly recording: Recording;
  readonly onDelete: (id: string) => void;
  readonly isDeleting: boolean;
}) {
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-border bg-card/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {formatCreatedAt(recording.createdAt)}
        </span>
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary">{formatDuration(recording.durationSeconds)}</Badge>
          <Badge variant="outline">{recording.sampleRate} Hz</Badge>
        </div>
      </div>
      <p className="text-sm leading-relaxed">
        {recording.transcript && recording.transcript.length > 0 ? (
          recording.transcript
        ) : (
          <span className="text-muted-foreground italic">No transcript</span>
        )}
      </p>
      <div className="flex items-center gap-2">
        {/* Native controls: transport, scrubbing, and duration for free, and
            they stay correct while the wav streams. `preload="none"` keeps a
            long list from fetching every recording's audio on mount. */}
        <audio
          className="h-8 min-w-0 flex-1"
          controls
          preload="none"
          src={recordingAudioUrl(recording.id)}
        />
        <Button
          aria-label="Delete recording"
          disabled={isDeleting}
          onClick={() => onDelete(recording.id)}
          size="icon-sm"
          variant="ghost"
        >
          {isDeleting ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Trash2 className="text-muted-foreground" />
          )}
        </Button>
      </div>
    </li>
  );
}

export function RecordingsList() {
  const { data, isPending, isError, error } = useRecordings();
  const remove = useDeleteRecording();

  if (isPending) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading recordings
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-destructive">
        <AlertCircle className="size-4" />
        {error instanceof Error ? error.message : "Failed to load recordings"}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
        <ListMusic className="size-5" />
        No recordings yet. Record something to see it here.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {remove.isError && (
        <div className="flex items-center gap-2 px-1 text-sm text-destructive">
          <AlertCircle className="size-4" />
          {remove.error instanceof Error
            ? remove.error.message
            : "Failed to delete recording"}
        </div>
      )}
      <ScrollArea className="max-h-96">
        <ul className="flex flex-col gap-2 pr-3">
          {data.map((recording) => (
            <RecordingRow
              key={recording.id}
              isDeleting={remove.isPending && remove.variables === recording.id}
              onDelete={(id) => remove.mutate(id)}
              recording={recording}
            />
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
}
