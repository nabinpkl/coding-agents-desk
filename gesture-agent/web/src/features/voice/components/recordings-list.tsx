/**
 * Truth view: the persisted recordings from the TanStack Query cache. It reads
 * `useRecordings` and renders loading / error / empty / list states. It holds
 * no momentum and never reaches into the voice store.
 */

"use client";

import { AlertCircle, ListMusic, Loader2 } from "lucide-react";

import { useRecordings } from "@/features/voice/use-recordings";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
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

function RecordingRow({ recording }: { readonly recording: Recording }) {
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
    </li>
  );
}

export function RecordingsList() {
  const { data, isPending, isError, error } = useRecordings();

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
    <ScrollArea className="max-h-96">
      <ul className="flex flex-col gap-2 pr-3">
        {data.map((recording) => (
          <RecordingRow key={recording.id} recording={recording} />
        ))}
      </ul>
    </ScrollArea>
  );
}
