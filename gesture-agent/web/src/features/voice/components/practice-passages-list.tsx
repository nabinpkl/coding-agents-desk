/**
 * Passage-first recording library. The passage owns intended text and baseline
 * selection; each disclosure beneath it is immutable attempt evidence.
 */

"use client";

import {
  AlertCircle,
  ChevronDown,
  GitCompareArrows,
  Loader2,
  Mic,
  Pencil,
  RefreshCw,
  Trash2,
  Volume2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ReferenceSpeechControls } from "@/features/voice/components/reference-speech-controls";
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
import {
  useDeletePracticePassage,
  useDeletePracticePassageAttempt,
  usePracticePassageAttempts,
  usePracticePassages,
  useReanalyzePracticeAttempt,
  useUpdatePracticePassageBaseline,
  useUpdatePracticePassageText,
} from "@/features/voice/use-practice-passages";
import { wordDiff } from "@/features/voice/word-diff";
import { ApiError, loadRecordingAudioURL, recordingAudioUrl } from "@/lib/api";
import { getHostConfig } from "@/lib/host-bridge";
import type {
  PracticePassage,
  Recording,
  ReferenceSpeechScopeRequest,
  WordPhoneGroup,
} from "@/lib/wire";
import { useVoiceStore } from "@/stores/voice-store";

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatCreatedAt(iso?: string | null): string {
  if (!iso) return "No attempts yet";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

function pauseLearnerAudio(except?: HTMLAudioElement): void {
  document
    .querySelectorAll<HTMLAudioElement>("audio[data-learner-audio]")
    .forEach((audio) => {
      if (audio !== except) audio.pause();
    });
}

function Section({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4 first:border-0 first:pt-0">
      <div>
        <h4 className="font-medium text-foreground">{title}</h4>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      {children}
    </section>
  );
}

function MachineIntendedDiff({
  machine,
  intended,
}: {
  readonly machine: string;
  readonly intended: string;
}) {
  const parts = useMemo(() => wordDiff(machine, intended), [machine, intended]);
  const differs = parts.some((part) => part.kind !== "same");
  return (
    <div className="flex flex-col gap-2">
      <p className="text-lg leading-relaxed text-foreground">
        {machine || <span className="italic text-muted-foreground">No machine transcript</span>}
      </p>
      {differs ? (
        <>
          <div
            aria-label="Word differences between machine heard and intended text"
            className="flex flex-wrap gap-1.5 text-sm"
          >
            {parts.map((part, index) => (
              <span
                className={
                  part.kind === "same"
                    ? "rounded bg-muted px-1.5 py-0.5"
                    : part.kind === "machine-only"
                      ? "rounded border border-destructive/40 px-1.5 py-0.5 line-through"
                      : "rounded border border-primary/40 px-1.5 py-0.5 font-medium"
                }
                key={`${part.kind}-${index}`}
              >
                <span className="sr-only">
                  {part.kind === "machine-only"
                    ? "Machine only: "
                    : part.kind === "intended-only"
                      ? "Intended only: "
                      : "Same: "}
                </span>
                {part.text}
              </span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            A difference means recognition and intended text differ. It is not a pronunciation score.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Machine heard and intended text use the same words.
        </p>
      )}
    </div>
  );
}

function AttemptTranscriptDiff({
  baseline,
  selected,
}: {
  readonly baseline: string;
  readonly selected: string;
}) {
  const parts = useMemo(
    () => wordDiff(baseline, selected),
    [baseline, selected],
  );
  return (
    <div
      aria-label="Word differences between machine transcripts A and B"
      className="flex flex-wrap gap-1.5 text-sm"
    >
      {parts.length === 0 ? (
        <span className="italic text-muted-foreground">
          Neither attempt has a machine transcript.
        </span>
      ) : (
        parts.map((part, index) => (
          <span
            className={
              part.kind === "same"
                ? "rounded bg-background px-1.5 py-0.5"
                : "rounded border border-border bg-background px-1.5 py-0.5"
            }
            key={`${part.kind}-${index}`}
          >
            <span className="sr-only">
              {part.kind === "machine-only"
                ? "Only in A: "
                : part.kind === "intended-only"
                  ? "Only in B: "
                  : "Same in A and B: "}
            </span>
            {part.kind === "machine-only" ? "A: " : null}
            {part.kind === "intended-only" ? "B: " : null}
            {part.text}
          </span>
        ))
      )}
    </div>
  );
}

function AttemptPhoneComparison({
  baseline,
  selected,
}: {
  readonly baseline: Recording;
  readonly selected: Recording;
}) {
  const rowCount = Math.max(
    baseline.wordPhoneGroups.length,
    selected.wordPhoneGroups.length,
  );
  if (rowCount === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Neither attempt has phone evidence.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      {Array.from({ length: rowCount }, (_, index) => {
        const baselineGroup = baseline.wordPhoneGroups[index];
        const selectedGroup = selected.wordPhoneGroups[index];
        const word =
          baselineGroup?.word ??
          selectedGroup?.word ??
          "Unassigned phones";
        return (
          <div
            className="grid gap-2 border-t border-border p-3 first:border-0 sm:grid-cols-[minmax(6rem,0.6fr)_1fr_1fr_1fr]"
            key={`${word}-${index}`}
          >
            <strong className="text-sm">{word}</strong>
            <div>
              <span className="text-xs text-muted-foreground">A heard</span>
              <p className="break-words font-mono">
                {baselineGroup?.heardPhones.join(" ") || "None aligned"}
              </p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">B heard</span>
              <p className="break-words font-mono">
                {selectedGroup?.heardPhones.join(" ") || "None aligned"}
              </p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Reference</span>
              <p className="break-words font-mono">
                {(
                  baselineGroup?.referencePhones ??
                  selectedGroup?.referencePhones ??
                  []
                ).join(" ") || "No reference phones"}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PhoneComparison({
  groups,
  onSpeakWord,
  activeWordIndex,
  disabled,
}: {
  readonly groups: readonly WordPhoneGroup[];
  readonly onSpeakWord: (index: number) => void;
  readonly activeWordIndex?: number;
  readonly disabled: boolean;
}) {
  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">No phone evidence available.</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {groups.map((group, index) => (
        <div
          className="grid gap-2 border-t border-border p-3 first:border-0 sm:grid-cols-[minmax(6rem,0.6fr)_1fr_1fr]"
          key={`${group.word ?? "unassigned"}-${index}`}
        >
          <div className="flex items-center gap-2">
            <strong className="text-sm">{group.word ?? "Unassigned phones"}</strong>
            {group.word && group.hasReferencePronunciation ? (
              <Button
                aria-label={`Hear reference word ${group.word}`}
                disabled={disabled}
                onClick={() => onSpeakWord(index)}
                size="icon-sm"
                variant="outline"
              >
                {activeWordIndex === index ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Volume2 />
                )}
              </Button>
            ) : null}
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Heard</span>
            <p className="break-words font-mono">
              {group.heardPhones.join(" ") || "None aligned"}
            </p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Reference</span>
            <p className="break-words font-mono">
              {group.hasReferencePronunciation
                ? group.referencePhones.join(" ") || "No reference phones"
                : "No dictionary entry"}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function LearnerAudio({ recordingID, label }: { recordingID: string; label: string }) {
  const nativeTransport = getHostConfig()?.voiceTransport === "native";
  const [url, setURL] = useState<string | undefined>(
    nativeTransport ? undefined : recordingAudioUrl(recordingID),
  );
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  useEffect(
    () => () => {
      if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    },
    [url],
  );
  async function load(): Promise<void> {
    setLoading(true);
    setError(undefined);
    try {
      setURL(await loadRecordingAudioURL(recordingID));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Audio unavailable");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {url ? (
        <audio
          aria-label={label}
          className="h-10 w-full"
          controls
          data-learner-audio
          onPlay={(event) => {
            stopReferenceSpeech();
            pauseLearnerAudio(event.currentTarget);
          }}
          preload="none"
          src={url}
        />
      ) : (
        <Button disabled={loading} onClick={() => void load()} variant="outline">
          {loading ? <Loader2 className="animate-spin" /> : <Volume2 />}
          Load {label}
        </Button>
      )}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function Attempt({
  recording,
  passage,
  newest,
  selected,
  onSelect,
  onSpeakWord,
  referenceDisabled,
  playback,
  onDeleted,
  onStatus,
  mutationsDisabled,
}: {
  readonly recording: Recording;
  readonly passage: PracticePassage;
  readonly newest: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onSpeakWord: (index: number) => void;
  readonly referenceDisabled: boolean;
  readonly playback: ReturnType<typeof referenceSpeechPlaybackSnapshot>;
  readonly onDeleted: () => void;
  readonly onStatus: (message: string) => void;
  readonly mutationsDisabled: boolean;
}) {
  const remove = useDeletePracticePassageAttempt();
  const reanalyze = useReanalyzePracticeAttempt();
  const baseline = useUpdatePracticePassageBaseline();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [open, setOpen] = useState(newest);
  const isBaseline = passage.baselineRecordingID === recording.id;
  const activeWordMatch = playback.requestKey?.match(
    new RegExp(
      `^${passage.id}:${passage.revision}:word:(\\d+)$`,
    ),
  );
  return (
    <details
      className="group/attempt rounded-lg border border-border bg-background"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronDown className="size-4 shrink-0 transition-transform group-open/attempt:rotate-180" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{formatCreatedAt(recording.createdAt)}</span>
          <span className="block text-xs text-muted-foreground">
            {formatDuration(recording.durationSeconds)} · {recording.source}
          </span>
        </span>
        {isBaseline ? <Badge>Baseline A</Badge> : null}
        {selected ? <Badge variant="secondary">Compare B</Badge> : null}
        <Badge variant={recording.status === "interrupted" ? "destructive" : "outline"}>
          {recording.status}
        </Badge>
      </summary>
      <div className="flex flex-col gap-4 border-t border-border p-4">
        <Section detail="Whisper observation retained unchanged" title="Machine heard">
          <MachineIntendedDiff
            intended={passage.intendedText}
            machine={recording.machineTranscript ?? ""}
          />
          {recording.transcriptionError ? (
            <p className="text-sm text-destructive">{recording.transcriptionError}</p>
          ) : null}
        </Section>
        <Section
          detail="Sequence-aligned to intended words, not acoustic word boundaries"
          title="Heard and reference phones"
        >
          <PhoneComparison
            activeWordIndex={
              playback.status === "preparing" && activeWordMatch
                ? Number(activeWordMatch[1])
                : undefined
            }
            disabled={referenceDisabled}
            groups={recording.wordPhoneGroups}
            onSpeakWord={onSpeakWord}
          />
          {recording.unknownReferenceWords.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              No dictionary entry: {recording.unknownReferenceWords.join(", ")}
            </p>
          ) : null}
          {playback.status === "error" &&
          playback.requestKey?.startsWith(
            `${passage.id}:${passage.revision}:`,
          ) ? (
            <p className="text-sm text-destructive" role="alert">
              {playback.error}
            </p>
          ) : null}
        </Section>
        <Section detail="Immutable audio from this attempt" title="Your recording">
          <LearnerAudio label="Your recording" recordingID={recording.id} />
        </Section>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground">
            Technical details
          </summary>
          <dl className="mt-2 grid gap-1 break-all">
            <div><dt className="inline font-medium">Recording: </dt><dd className="inline">{recording.id}</dd></div>
            <div><dt className="inline font-medium">Passage revision: </dt><dd className="inline">{recording.passageRevision}</dd></div>
            <div><dt className="inline font-medium">Sample rate: </dt><dd className="inline">{recording.sampleRate} Hz</dd></div>
            <div><dt className="inline font-medium">Phone model: </dt><dd className="inline">{recording.phoneModelIdentifier ?? "Unavailable"}</dd></div>
            <div><dt className="inline font-medium">Dictionary: </dt><dd className="inline">{recording.referenceDictionaryIdentifier ?? "Unavailable"}</dd></div>
            {recording.transport ? (
              <div><dt className="inline font-medium">Transport: </dt><dd className="inline">{recording.transport.continuityStatus}, {recording.transport.receivedFrameCount} frames</dd></div>
            ) : null}
          </dl>
        </details>
        {[remove.error, reanalyze.error, baseline.error].find(Boolean) ? (
          <p className="text-sm text-destructive" role="alert">
            {[remove.error, reanalyze.error, baseline.error].find(Boolean)?.message}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <Button disabled={mutationsDisabled} onClick={onSelect} variant="outline">
            <GitCompareArrows /> Compare as B
          </Button>
          <Button
            disabled={baseline.isPending || mutationsDisabled}
            onClick={() => {
              stopReferenceSpeech();
              pauseLearnerAudio();
              baseline.mutate(
                {
                  passageID: passage.id,
                  request: {
                    expectedRevision: passage.revision,
                    recordingId: isBaseline ? null : recording.id,
                  },
                },
                {
                  onSuccess: () =>
                    onStatus(
                      isBaseline
                        ? "Baseline cleared."
                        : "Baseline attempt updated.",
                    ),
                },
              );
            }}
            variant="outline"
          >
            {isBaseline ? "Clear baseline" : "Use as baseline"}
          </Button>
          <Button
            disabled={reanalyze.isPending || mutationsDisabled}
            onClick={() =>
              reanalyze.mutate(recording.id, {
                onSuccess: () => onStatus("Attempt reanalysis completed."),
              })
            }
            variant="outline"
          >
            <RefreshCw className={reanalyze.isPending ? "animate-spin" : ""} />
            Reanalyze
          </Button>
          <Button
            disabled={mutationsDisabled}
            onClick={() => setConfirmDelete(true)}
            variant="destructive"
          >
            <Trash2 /> Delete attempt
          </Button>
        </div>
      </div>
      <Dialog onOpenChange={setConfirmDelete} open={confirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this attempt?</DialogTitle>
            <DialogDescription>
              Its recording, transcript observation, and analysis will be removed. The passage remains.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              disabled={remove.isPending || mutationsDisabled}
              onClick={() => {
                stopReferenceSpeech();
                pauseLearnerAudio();
                remove.mutate(
                  { passageID: passage.id, recordingID: recording.id },
                  {
                    onSuccess: () => {
                      setConfirmDelete(false);
                      onStatus("Attempt deleted.");
                      onDeleted();
                    },
                  },
                );
              }}
              variant="destructive"
            >
              Delete attempt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </details>
  );
}

function Passage({
  passage,
  onRetake,
  completedPassageID,
  referencePreferences,
  playback,
  onDeleted,
  onStatus,
}: {
  readonly passage: PracticePassage;
  readonly onRetake: (passage: PracticePassage) => void;
  readonly completedPassageID?: string;
  readonly referencePreferences?: ReferenceSpeechPreferences;
  readonly playback: ReturnType<typeof referenceSpeechPlaybackSnapshot>;
  readonly onDeleted: (passageID: string) => void;
  readonly onStatus: (message: string) => void;
}) {
  const [open, setOpen] = useState(completedPassageID === passage.id);
  const attempts = usePracticePassageAttempts(
    passage.id,
    passage.revision,
    open,
  );
  const updateText = useUpdatePracticePassageText();
  const removePassage = useDeletePracticePassage();
  const [editing, setEditing] = useState(passage.intendedText.length === 0);
  const [draft, setDraft] = useState(passage.intendedText);
  const [editRevision, setEditRevision] = useState(passage.revision);
  const [selectedID, setSelectedID] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const passageSummaryRef = useRef<HTMLElement>(null);
  const voiceStatus = useVoiceStore((state) => state.runState.status);
  const isCaptureBusy = !["idle", "complete", "error"].includes(voiceStatus);
  const allAttempts = attempts.data?.pages.flatMap((page) => page.attempts) ?? [];
  const baselineAttempt = allAttempts.find(
    (attempt) => attempt.id === passage.baselineRecordingID,
  );
  const selectedAttempt = allAttempts.find((attempt) => attempt.id === selectedID);
  const editConflict =
    updateText.error instanceof ApiError && updateText.error.status === 409;

  useEffect(
    () => () => {
      if (
        referenceSpeechPlaybackSnapshot().requestKey?.startsWith(
          `${passage.id}:`,
        )
      ) {
        stopReferenceSpeech();
      }
    },
    [passage.id, passage.revision],
  );

  async function playReference(scope: ReferenceSpeechScopeRequest): Promise<void> {
    if (!referencePreferences) return;
    pauseLearnerAudio();
    try {
      await speakReference(
        passage.id,
        passage.revision,
        scope,
        referencePreferences,
      );
    } catch {
      // speakReference publishes the actionable failure into the shared
      // playback state rendered below.
    }
  }

  return (
    <Card>
      <details
        className="group/passage"
        onToggle={(event) => setOpen(event.currentTarget.open)}
        open={open}
      >
        <summary
          className="flex cursor-pointer list-none items-start gap-3 px-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-passage-summary={passage.id}
          ref={passageSummaryRef}
        >
          <ChevronDown className="mt-1 size-5 shrink-0 transition-transform group-open/passage:rotate-180" />
          <span className="min-w-0 flex-1">
            <span className="block text-base font-semibold">
              {passage.intendedText || "Intended text needs review"}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {passage.attemptCount} {passage.attemptCount === 1 ? "attempt" : "attempts"} · {formatCreatedAt(passage.latestAttemptCreatedAt)}
            </span>
          </span>
          {passage.baselineRecordingID ? <Badge variant="secondary">Baseline set</Badge> : null}
        </summary>
        <CardContent className="flex flex-col gap-5 border-t border-border pt-4">
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-medium">Intended text</h3>
                <p className="text-xs text-muted-foreground">
                  Human-owned reference for every take in this passage.
                </p>
              </div>
              {!editing ? (
                <Button
                  disabled={isCaptureBusy}
                  onClick={() => {
                    setDraft(passage.intendedText);
                    setEditRevision(passage.revision);
                    setEditing(true);
                  }}
                  variant="outline"
                >
                  <Pencil /> Edit
                </Button>
              ) : null}
            </div>
            {editing ? (
              <div className="flex flex-col gap-2">
                <textarea
                  aria-label="Intended text"
                  autoFocus
                  className="min-h-24 rounded-md border border-input bg-background p-3 text-base outline-none focus:ring-2 focus:ring-ring"
                  maxLength={4000}
                  onChange={(event) => setDraft(event.target.value)}
                  value={draft}
                />
                <div className="flex gap-2">
                  <Button
                    disabled={updateText.isPending || draft.trim().length === 0 || isCaptureBusy}
                    onClick={() => {
                      stopReferenceSpeech();
                      updateText.mutate(
                        {
                          passageID: passage.id,
                          request: {
                            intendedText: draft,
                            expectedRevision: editRevision,
                          },
                        },
                        {
                          onSuccess: () => {
                            setEditing(false);
                            onStatus("Intended text updated.");
                          },
                        },
                      );
                    }}
                  >
                    {updateText.isPending ? <Loader2 className="animate-spin" /> : null}
                    Save
                  </Button>
                  <Button
                    onClick={() => {
                      updateText.reset();
                      setDraft(passage.intendedText);
                      setEditing(false);
                    }}
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                </div>
                {editConflict ? (
                  <p className="text-sm text-destructive" role="alert">
                    Intended text changed on another surface. Cancel, review the current text, then edit again.
                  </p>
                ) : updateText.error ? (
                  <p className="text-sm text-destructive" role="alert">
                    {updateText.error.message}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-xl leading-relaxed">{passage.intendedText}</p>
            )}
          </section>

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={isCaptureBusy || editing}
              onClick={() => {
                stopReferenceSpeech();
                pauseLearnerAudio();
                onRetake(passage);
              }}
            >
              <Mic /> Record another take
            </Button>
            <Button
              disabled={
                editing ||
                isCaptureBusy ||
                !referencePreferences ||
                passage.intendedText.length === 0
              }
              onClick={() => void playReference({ kind: "passage" })}
              variant="outline"
            >
              {playback.requestKey === `${passage.id}:${passage.revision}:passage` &&
              playback.status === "preparing" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Volume2 />
              )}
              Hear reference
            </Button>
            <Button
              disabled={isCaptureBusy}
              onClick={() => setConfirmDelete(true)}
              variant="destructive"
            >
              <Trash2 /> Delete passage
            </Button>
          </div>

          {baselineAttempt && selectedAttempt && baselineAttempt.id !== selectedAttempt.id ? (
            <section aria-label="A/B attempt comparison" className="rounded-lg bg-muted/50 p-4">
              <div className="mb-3">
                <h3 className="font-medium">A/B playback</h3>
                <p className="text-xs text-muted-foreground">
                  Listen separately. No score or improvement claim is inferred.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <LearnerAudio label="Baseline A" recordingID={baselineAttempt.id} />
                <LearnerAudio label="Selected B" recordingID={selectedAttempt.id} />
              </div>
              <div className="mt-4 flex flex-col gap-2">
                <h4 className="text-sm font-medium">
                  Machine transcript differences
                </h4>
                <AttemptTranscriptDiff
                  baseline={baselineAttempt.machineTranscript ?? ""}
                  selected={selectedAttempt.machineTranscript ?? ""}
                />
              </div>
              <div className="mt-4 flex flex-col gap-2">
                <h4 className="text-sm font-medium">
                  Heard-phone evidence
                </h4>
                <p className="text-xs text-muted-foreground">
                  Sequence-aligned to intended words, not acoustic word boundaries.
                </p>
                <AttemptPhoneComparison
                  baseline={baselineAttempt}
                  selected={selectedAttempt}
                />
              </div>
            </section>
          ) : null}

          <section className="flex flex-col gap-3">
            <div>
              <h3 className="font-medium">Attempts</h3>
              <p className="text-xs text-muted-foreground">
                Newest first. Expand a take to compare recognition, audio, and phone evidence.
              </p>
            </div>
            {attempts.isPending ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading attempts
              </p>
            ) : attempts.error ? (
              <p className="text-sm text-destructive" role="alert">{attempts.error.message}</p>
            ) : allAttempts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This passage has no attempts. Record another take or delete the passage.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {allAttempts.map((recording, index) => (
                  <Attempt
                    key={recording.id}
                    mutationsDisabled={isCaptureBusy}
                    newest={index === 0}
                    onDeleted={() =>
                      window.requestAnimationFrame(() =>
                        passageSummaryRef.current?.focus(),
                      )
                    }
                    onStatus={onStatus}
                    onSelect={() => setSelectedID(recording.id)}
                    onSpeakWord={(index) =>
                      void playReference({ kind: "word", index })
                    }
                    passage={passage}
                    playback={playback}
                    recording={recording}
                    referenceDisabled={
                      isCaptureBusy || !referencePreferences
                    }
                    selected={recording.id === selectedID}
                  />
                ))}
                {attempts.hasNextPage ? (
                  <Button
                    disabled={attempts.isFetchingNextPage}
                    onClick={() => void attempts.fetchNextPage()}
                    variant="outline"
                  >
                    {attempts.isFetchingNextPage ? <Loader2 className="animate-spin" /> : null}
                    Show earlier attempts
                  </Button>
                ) : null}
              </div>
            )}
          </section>
        </CardContent>
      </details>
      <Dialog onOpenChange={setConfirmDelete} open={confirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this passage?</DialogTitle>
            <DialogDescription>
              This removes all {passage.attemptCount} attempts and their WAV files. Shared rebuildable reference-audio cache entries may remain.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              disabled={removePassage.isPending || isCaptureBusy}
              onClick={() => {
                stopReferenceSpeech();
                pauseLearnerAudio();
                removePassage.mutate(passage.id, {
                  onSuccess: () => {
                    setConfirmDelete(false);
                    onStatus("Passage and its attempts deleted.");
                    onDeleted(passage.id);
                  },
                });
              }}
              variant="destructive"
            >
              Delete passage and attempts
            </Button>
          </DialogFooter>
          {removePassage.error ? (
            <p className="text-sm text-destructive" role="alert">
              {removePassage.error.message}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function PracticePassagesList({
  onRetake,
  completedPassageID,
}: {
  readonly onRetake: (passage: PracticePassage) => void;
  readonly completedPassageID?: string;
}) {
  const passages = usePracticePassages();
  const allPassages =
    passages.data?.pages.flatMap((page) => page.passages) ?? [];
  const voiceStatus = useVoiceStore((state) => state.runState.status);
  const [status, setStatus] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const settings = useReferenceSpeechSettings();
  const playback = useSyncExternalStore(
    subscribeReferenceSpeechPlayback,
    referenceSpeechPlaybackSnapshot,
    referenceSpeechPlaybackSnapshot,
  );
  useEffect(() => () => stopReferenceSpeech(), []);

  function restoreFocusAfterPassageDeletion(passageID: string): void {
    const deletedIndex = allPassages.findIndex(
      (passage) => passage.id === passageID,
    );
    const focusID =
      allPassages[deletedIndex + 1]?.id ??
      allPassages[deletedIndex - 1]?.id;
    window.requestAnimationFrame(() => {
      if (focusID) {
        document
          .querySelector<HTMLElement>(
            `[data-passage-summary="${focusID}"]`,
          )
          ?.focus();
      } else {
        headingRef.current?.focus();
      }
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card>
        <CardContent>
          <ReferenceSpeechControls
            disabled={voiceStatus === "requestingMic" || voiceStatus === "capturing"}
            update={settings.update}
            view={settings.view}
          />
        </CardContent>
      </Card>
      <section aria-labelledby="practice-passages-heading" className="flex flex-col gap-4">
        <div>
          <h2
            className="text-2xl font-semibold outline-none"
            id="practice-passages-heading"
            ref={headingRef}
            tabIndex={-1}
          >
            Practice passages
          </h2>
          <p className="text-sm text-muted-foreground">
            Keep intended text stable while retaining every machine observation and take.
          </p>
        </div>
        {passages.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading passages
          </p>
        ) : passages.error ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <AlertCircle className="size-4" /> {passages.error.message}
          </p>
        ) : allPassages.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No passages yet. Record a new passage to begin.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {allPassages.map((passage) => (
              <Passage
                completedPassageID={completedPassageID}
                key={`${passage.id}:${completedPassageID === passage.id ? "completed" : "stable"}`}
                onRetake={onRetake}
                onDeleted={restoreFocusAfterPassageDeletion}
                onStatus={setStatus}
                passage={passage}
                playback={playback}
                referencePreferences={
                  settings.view.status === "ready"
                    ? settings.view.preferences
                    : undefined
                }
              />
            ))}
            {passages.hasNextPage ? (
              <Button
                disabled={passages.isFetchingNextPage}
                onClick={() => void passages.fetchNextPage()}
                variant="outline"
              >
                {passages.isFetchingNextPage ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                Show earlier passages
              </Button>
            ) : null}
          </div>
        )}
        <p aria-live="polite" className="sr-only" role="status">
          {status}
        </p>
      </section>
    </div>
  );
}
