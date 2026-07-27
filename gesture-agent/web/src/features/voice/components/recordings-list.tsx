/**
 * Truth view: the persisted recordings from the TanStack Query cache. It reads
 * `useRecordings` and renders loading / error / empty / list states. It holds
 * no momentum and never reaches into the voice store. The server returns the
 * list newest-first; this view does not re-sort it.
 */

"use client";

import { AlertCircle, ListMusic, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import {
  useDeleteRecording,
  useReanalyzeRecording,
  useRecordings,
} from "@/features/voice/use-recordings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { loadRecordingAudioURL, recordingAudioUrl } from "@/lib/api";
import { getHostConfig } from "@/lib/host-bridge";
import type { Recording, WordPhoneGroup } from "@/lib/wire";

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

function PassageCard({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-background/70 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </div>
      {children}
    </section>
  );
}

function GroupedPhones({
  groups,
  column,
}: {
  readonly groups: readonly WordPhoneGroup[];
  readonly column: "heard" | "reference";
}) {
  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">No word groups available.</p>;
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-3 leading-relaxed">
      {groups.map((group, index) => {
        const phones =
          column === "heard" ? group.heardPhones : group.referencePhones;
        let emptyText = "No raw phones aligned";
        if (column === "reference") {
          emptyText =
            group.word === null
              ? "Raw phones only"
              : group.hasReferencePronunciation
                ? "No reference phones"
                : "No dictionary entry";
        }
        return (
          <span
            className="inline-flex max-w-full items-baseline gap-2"
            key={`${group.word ?? "unassigned"}-${index}`}
          >
            <span className="shrink-0 text-sm font-semibold text-muted-foreground">
              {group.word ?? "No word anchor"}
            </span>
            <span
              className={
                phones.length > 0
                  ? "font-mono text-base"
                  : "text-xs italic text-muted-foreground"
              }
            >
              {phones.length > 0 ? phones.join("\u00a0\u00a0") : emptyText}
            </span>
          </span>
        );
      })}
    </div>
  );
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
  const wordPhoneGroups = recording.wordPhoneGroups ?? [];
  const unknownReferenceWords = recording.unknownReferenceWords ?? [];
  const nativeTransport = getHostConfig()?.voiceTransport === "native";
  const [audioURL, setAudioURL] = useState<string | undefined>(
    nativeTransport ? undefined : recordingAudioUrl(recording.id),
  );
  const [audioError, setAudioError] = useState<string>();
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const reanalyze = useReanalyzeRecording();
  useEffect(() => {
    return () => {
      if (audioURL?.startsWith("blob:")) URL.revokeObjectURL(audioURL);
    };
  }, [audioURL]);

  async function loadAudio(): Promise<void> {
    setIsLoadingAudio(true);
    setAudioError(undefined);
    try {
      setAudioURL(await loadRecordingAudioURL(recording.id));
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "Audio unavailable");
    } finally {
      setIsLoadingAudio(false);
    }
  }

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {formatCreatedAt(recording.createdAt)}
        </span>
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary">{formatDuration(recording.durationSeconds)}</Badge>
          <Badge variant="outline">
            {recording.source === "iphone" ? "iPhone" : recording.source === "macos" ? "Mac" : "Browser"}
          </Badge>
          <Badge variant={recording.status === "interrupted" ? "destructive" : "outline"}>
            {recording.status}
          </Badge>
          <Badge variant="outline">{recording.sampleRate} Hz</Badge>
        </div>
      </div>
      <div className="grid gap-2">
        <PassageCard detail="Saved transcript" title="Transcript">
          <p className="text-base leading-relaxed">
            {recording.transcript && recording.transcript.length > 0 ? (
              recording.transcript
            ) : (
              <span className="text-muted-foreground italic">No transcript</span>
            )}
          </p>
          {recording.transcriptionError && (
            <p className="text-xs text-destructive">
              Transcription failed: {recording.transcriptionError}
            </p>
          )}
        </PassageCard>

        <PassageCard detail="Transcript-aligned" title="Phonemes heard">
          <GroupedPhones column="heard" groups={wordPhoneGroups} />
          {recording.phoneAnalysisError && (
            <p className="text-xs text-destructive">
              Phone analysis failed: {recording.phoneAnalysisError}
            </p>
          )}
          {recording.phoneModelIdentifier && (
            <p className="text-xs text-muted-foreground">
              {recording.phoneModelIdentifier}
              {recording.phoneRuntimeIdentifier
                ? ` · ${recording.phoneRuntimeIdentifier}`
                : ""}
            </p>
          )}
        </PassageCard>

        <PassageCard
          detail={recording.referenceDictionaryIdentifier ?? "CMUdict by word"}
          title="Reference phonemes"
        >
          <GroupedPhones column="reference" groups={wordPhoneGroups} />
          {recording.referencePronunciationError && (
            <p className="text-xs text-destructive">
              Reference pronunciation failed:{" "}
              {recording.referencePronunciationError}
            </p>
          )}
          {unknownReferenceWords.length > 0 && (
            <p className="text-xs text-muted-foreground">
              No dictionary entry: {unknownReferenceWords.join(", ")}
            </p>
          )}
        </PassageCard>
      </div>
      {reanalyze.isError && (
        <p className="text-xs text-destructive">
          {reanalyze.error instanceof Error
            ? reanalyze.error.message
            : "Reanalysis failed"}
        </p>
      )}
      {audioError && <p className="text-xs text-destructive">{audioError}</p>}
      <div className="flex items-center gap-2">
        {audioURL ? (
          <audio
            className="h-8 min-w-0 flex-1"
            controls
            preload="none"
            src={audioURL}
          />
        ) : (
          <Button
            disabled={isLoadingAudio}
            onClick={() => void loadAudio()}
            size="sm"
            variant="outline"
          >
            {isLoadingAudio && <Loader2 className="animate-spin" />}
            Load audio
          </Button>
        )}
        <Button
          aria-label="Reanalyze recording"
          disabled={reanalyze.isPending}
          onClick={() => reanalyze.mutate(recording.id)}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCw className={reanalyze.isPending ? "animate-spin" : ""} />
        </Button>
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
      <ScrollArea className="max-h-[42rem]">
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
