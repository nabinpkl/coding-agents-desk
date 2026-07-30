/**
 * Top-level composition for the voice feature: the live recorder (momentum) and
 * the persisted recordings list (truth), side by side. Pure layout; every piece
 * of logic lives in the hooks and store beneath it.
 */

"use client";

import { useState } from "react";

import { PracticePassagesList } from "@/features/voice/components/practice-passages-list";
import { VoiceRecorder } from "@/features/voice/components/voice-recorder";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { PracticePassage, Recording } from "@/lib/wire";

export function VoicePanel() {
  const [retakePassage, setRetakePassage] = useState<PracticePassage>();
  const [completedPassageID, setCompletedPassageID] = useState<string>();

  function completed(recording: Recording): void {
    setCompletedPassageID(recording.passageId);
    setRetakePassage(undefined);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Live capture</CardTitle>
          <CardDescription>
            Stream your microphone to the local Sherpa ASR backend and watch the
            transcript build in real time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VoiceRecorder
            onComplete={completed}
            onNewPassage={() => setRetakePassage(undefined)}
            passage={retakePassage}
          />
        </CardContent>
      </Card>

      <div className="flex min-w-0 flex-col gap-6">
        <PracticePassagesList
          completedPassageID={completedPassageID}
          onRetake={(passage) => {
            setCompletedPassageID(undefined);
            setRetakePassage(passage);
          }}
        />
      </div>
    </div>
  );
}
