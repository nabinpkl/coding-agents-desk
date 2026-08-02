/**
 * Top-level composition for the voice feature: the live recorder (momentum) and
 * the persisted recordings list (truth), side by side. Pure layout; every piece
 * of logic lives in the hooks and store beneath it.
 */

"use client";

import { RecordingsList } from "@/features/voice/components/recordings-list";
import { VoiceRecorder } from "@/features/voice/components/voice-recorder";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function VoicePanel() {
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
          <VoiceRecorder />
        </CardContent>
      </Card>

      <div className="flex min-w-0 flex-col gap-6">
        <RecordingsList />
      </div>
    </div>
  );
}
