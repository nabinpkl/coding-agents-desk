/**
 * Truth view: the persisted recordings from the TanStack Query cache. It reads
 * `useRecordings` and renders loading / error / empty / list states. It holds
 * no momentum and never reaches into the voice store. The server returns the
 * list newest-first; this view does not re-sort it.
 */

"use client";

import {
  AlertCircle,
  ListMusic,
  Loader2,
  RefreshCw,
  Trash2,
  Volume2,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import {
  useDeleteRecording,
  useReanalyzeRecording,
  useRecordings,
} from "@/features/voice/use-recordings";
import {
  referenceSpeechPlaybackSnapshot,
  speakReference,
  stopReferenceSpeech,
  subscribeReferenceSpeechPlayback,
} from "@/features/voice/reference-speech";
import {
  type ReferenceSpeechPreferences,
  useReferenceSpeechSettings,
} from "@/features/voice/reference-speech-settings";
import { ReferenceSpeechControls } from "@/features/voice/components/reference-speech-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { loadRecordingAudioURL, recordingAudioUrl } from "@/lib/api";
import { getHostConfig } from "@/lib/host-bridge";
import type {
  Recording,
  ReferenceSpeechScopeRequest,
  WordPhoneGroup,
} from "@/lib/wire";
import { useVoiceStore } from "@/stores/voice-store";

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

function PassageSection({
  title,
  detail,
  action,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-base font-semibold tracking-tight">{title}</h3>
          <span className="text-xs text-muted-foreground">{detail}</span>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function GroupedPhones({
  groups,
  column,
  referenceSpeechDisabled,
  onSpeakWord,
  activeRequestKey,
  recordingID,
}: {
  readonly groups: readonly WordPhoneGroup[];
  readonly column: "heard" | "reference";
  readonly referenceSpeechDisabled?: boolean;
  readonly onSpeakWord?: (index: number) => void;
  readonly activeRequestKey?: string;
  readonly recordingID?: string;
}) {
  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">No word groups available.</p>;
  }

  return (
    <div className="flex flex-wrap gap-2.5" role="list">
      {groups.map((group, index) => {
        const word = group.word;
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
          <div
            className="flex max-w-full items-center gap-2 rounded-md bg-muted/60 px-2.5 py-2"
            key={`${group.word ?? "unassigned"}-${index}`}
            role="listitem"
          >
            <span className="shrink-0 text-sm font-semibold text-foreground">
              {word ?? "No word anchor"}
            </span>
            {column === "reference" && word !== null && onSpeakWord ? (
              <Button
                aria-label={`Hear reference word ${word}`}
                className="size-11 border-border bg-background text-foreground shadow-none"
                disabled={
                  referenceSpeechDisabled ||
                  !group.hasReferencePronunciation
                }
                onClick={() => onSpeakWord(index)}
                size="icon-sm"
                title={`Hear “${word}”`}
                variant="outline"
              >
                {activeRequestKey === `${recordingID}:word:${index}` ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Volume2 className="size-4" />
                )}
              </Button>
            ) : null}
            <span
              className={
                phones.length > 0
                  ? "min-w-0 break-words font-mono text-[0.95rem] leading-6 text-foreground"
                  : "text-xs italic text-muted-foreground"
              }
            >
              {phones.length > 0 ? phones.join("\u00a0\u00a0") : emptyText}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RecordingRow({
  recording,
  onDelete,
  isDeleting,
  referenceSpeechDisabled,
  referenceSpeechPreferences,
  playback,
}: {
  readonly recording: Recording;
  readonly onDelete: (id: string) => void;
  readonly isDeleting: boolean;
  readonly referenceSpeechDisabled: boolean;
  readonly referenceSpeechPreferences?: ReferenceSpeechPreferences;
  readonly playback: ReturnType<typeof referenceSpeechPlaybackSnapshot>;
}) {
  const wordPhoneGroups = recording.wordPhoneGroups ?? [];
  const unknownReferenceWords = recording.unknownReferenceWords ?? [];
  const referenceText = recording.transcript?.trim() ?? "";
  const nativeTransport = getHostConfig()?.voiceTransport === "native";
  const [audioURL, setAudioURL] = useState<string | undefined>(
    nativeTransport ? undefined : recordingAudioUrl(recording.id),
  );
  const [audioError, setAudioError] = useState<string>();
  const [referenceSpeechError, setReferenceSpeechError] = useState<string>();
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

  async function playReference(scope: ReferenceSpeechScopeRequest): Promise<void> {
    if (!referenceSpeechPreferences) {
      setReferenceSpeechError("Reference speech is still loading.");
      return;
    }
    try {
      setReferenceSpeechError(undefined);
      await speakReference(
        recording.id,
        scope,
        referenceSpeechPreferences,
      );
    } catch (error) {
      setReferenceSpeechError(
        error instanceof Error
          ? error.message
          : "Reference speech is unavailable.",
      );
    }
  }

  return (
    <li className="flex flex-col gap-5 border-b border-border py-5 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm font-medium text-foreground">
          {formatCreatedAt(recording.createdAt)}
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
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
      <div className="flex flex-col gap-4">
        <PassageSection detail="Saved transcript" title="Transcript">
          <p className="text-lg leading-relaxed text-foreground">
            {recording.transcript && recording.transcript.length > 0 ? (
              recording.transcript
            ) : (
              <span className="text-muted-foreground italic">No transcript</span>
            )}
          </p>
          {recording.transcriptionError && (
            <p className="border-l-2 border-destructive px-2 text-sm text-destructive">
              Transcription failed: {recording.transcriptionError}
            </p>
          )}
        </PassageSection>

        <PassageSection detail="Transcript-aligned" title="Phonemes heard">
          <GroupedPhones column="heard" groups={wordPhoneGroups} />
          {recording.phoneAnalysisError && (
            <p className="border-l-2 border-destructive px-2 text-sm text-destructive">
              Phone analysis failed: {recording.phoneAnalysisError}
            </p>
          )}
          {recording.phoneModelIdentifier && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none font-medium text-foreground">
                Analysis details
              </summary>
              <p className="mt-1.5 break-all">
                {recording.phoneModelIdentifier}
                {recording.phoneRuntimeIdentifier
                  ? ` · ${recording.phoneRuntimeIdentifier}`
                  : ""}
              </p>
            </details>
          )}
        </PassageSection>

        <PassageSection
          action={
            <Button
              className="min-h-11 border-border bg-background px-3 text-foreground"
              disabled={
                referenceSpeechDisabled ||
                referenceText.length === 0 ||
                unknownReferenceWords.length > 0
              }
              onClick={() => void playReference({ kind: "passage" })}
              size="sm"
              title="Hear the full reference passage"
              variant="outline"
            >
              {playback.requestKey === `${recording.id}:passage` &&
              playback.status === "preparing" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Volume2 className="size-4" />
              )}
              Hear passage
            </Button>
          }
          detail="Pronunciation reference"
          title="Reference phonemes"
        >
          <GroupedPhones
            column="reference"
            groups={wordPhoneGroups}
            onSpeakWord={(index) =>
              void playReference({ kind: "word", index })
            }
            referenceSpeechDisabled={referenceSpeechDisabled}
            activeRequestKey={
              playback.status === "preparing"
                ? playback.requestKey
                : undefined
            }
            recordingID={recording.id}
          />
          {recording.referencePronunciationError && (
            <p className="border-l-2 border-destructive px-2 text-sm text-destructive">
              Reference pronunciation failed:{" "}
              {recording.referencePronunciationError}
            </p>
          )}
          {unknownReferenceWords.length > 0 && (
            <p className="text-sm text-muted-foreground">
              No dictionary entry: {unknownReferenceWords.join(", ")}
            </p>
          )}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none font-medium text-foreground">
              Reference source
            </summary>
            <p className="mt-1.5 break-all">
              {recording.referenceDictionaryIdentifier ?? "CMUdict by word"}
            </p>
          </details>
          {referenceSpeechError && (
            <p className="border-l-2 border-destructive px-2 text-sm text-destructive">
              {referenceSpeechError}
            </p>
          )}
          {playback.status === "error" &&
          playback.requestKey?.startsWith(`${recording.id}:`) ? (
            <p className="border-l-2 border-destructive px-2 text-sm text-destructive">
              {playback.error}
            </p>
          ) : null}
        </PassageSection>
      </div>
      {reanalyze.isError && (
        <p className="border-l-2 border-destructive px-2 text-sm text-destructive">
          {reanalyze.error instanceof Error
            ? reanalyze.error.message
            : "Reanalysis failed"}
        </p>
      )}
      {audioError && (
        <p className="border-l-2 border-destructive px-2 text-sm text-destructive">
          {audioError}
        </p>
      )}
      <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center">
        {audioURL ? (
          <audio
            className="h-11 w-full min-w-0 sm:flex-1"
            controls
            preload="none"
            src={audioURL}
          />
        ) : (
          <Button
            disabled={isLoadingAudio}
            onClick={() => void loadAudio()}
            size="default"
            variant="outline"
            className="min-h-11 w-full sm:w-auto"
          >
            {isLoadingAudio && <Loader2 className="animate-spin" />}
            Load audio
          </Button>
        )}
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Button
            className="min-h-11 border-border bg-background text-foreground"
            disabled={reanalyze.isPending}
            onClick={() => reanalyze.mutate(recording.id)}
            size="default"
            variant="outline"
          >
            <RefreshCw className={reanalyze.isPending ? "animate-spin" : ""} />
            Reanalyze
          </Button>
          <Button
            className="min-h-11"
            disabled={isDeleting}
            onClick={() => onDelete(recording.id)}
            size="default"
            variant="destructive"
          >
            {isDeleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Delete
          </Button>
        </div>
      </div>
    </li>
  );
}

export function RecordingsList() {
  const { data, isPending, isError, error } = useRecordings();
  const remove = useDeleteRecording();
  const voiceStatus = useVoiceStore((state) => state.runState.status);
  const referenceSettings = useReferenceSpeechSettings();
  const playback = useSyncExternalStore(
    subscribeReferenceSpeechPlayback,
    referenceSpeechPlaybackSnapshot,
    referenceSpeechPlaybackSnapshot,
  );
  const referenceSpeechDisabled =
    voiceStatus === "requestingMic" ||
    voiceStatus === "capturing" ||
    referenceSettings.view.status !== "ready";
  useEffect(() => () => stopReferenceSpeech(), []);

  let content: ReactNode;
  if (isPending) {
    content = (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading recordings
      </div>
    );
  } else if (isError) {
    content = (
      <div className="flex items-center gap-2 p-4 text-sm text-destructive">
        <AlertCircle className="size-4" />
        {error instanceof Error ? error.message : "Failed to load recordings"}
      </div>
    );
  } else if (data.length === 0) {
    content = (
      <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
        <ListMusic className="size-5" />
        No recordings yet. Record something to see it here.
      </div>
    );
  } else {
    content = (
      <>
        {remove.isError && (
          <div className="flex items-center gap-2 px-1 text-sm text-destructive">
            <AlertCircle className="size-4" />
            {remove.error instanceof Error
              ? remove.error.message
              : "Failed to delete recording"}
          </div>
        )}
        <ul className="flex flex-col gap-2">
          {data.map((recording) => (
            <RecordingRow
              key={recording.id}
              isDeleting={remove.isPending && remove.variables === recording.id}
              onDelete={(id) => remove.mutate(id)}
              recording={recording}
              referenceSpeechDisabled={referenceSpeechDisabled}
              referenceSpeechPreferences={
                referenceSettings.view.status === "ready"
                  ? referenceSettings.view.preferences
                  : undefined
              }
              playback={playback}
            />
          ))}
        </ul>
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card>
        <CardContent>
          <ReferenceSpeechControls
            disabled={
              voiceStatus === "requestingMic" || voiceStatus === "capturing"
            }
            update={referenceSettings.update}
            view={referenceSettings.view}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Saved recordings</CardTitle>
          <CardDescription>
            Transcript, heard phonemes, and pronunciation references by word.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">{content}</CardContent>
      </Card>
    </div>
  );
}
