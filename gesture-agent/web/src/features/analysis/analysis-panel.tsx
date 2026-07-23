"use client";

/**
 * Top-level analysis surface. Owns the shared recordings list (truth) and the
 * signal-selection momentum, then splits into two tabs: per-recording signal
 * curves and a two-recording pronunciation comparison. Dumb children read from
 * props; all fetching is in hooks.
 */

import { AlertCircle, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

import { PronunciationView } from "./components/pronunciation-view";
import { SignalAnalysisView } from "./components/signal-analysis-view";
import { useRecordings } from "./hooks";

export function AnalysisPanel() {
  const recordingsQuery = useRecordings();
  const [signalRecordingId, setSignalRecordingId] = useState<string | null>(
    null,
  );

  if (recordingsQuery.isPending) {
    return (
      <Notice icon="spin" role="status">
        Loading recordings…
      </Notice>
    );
  }

  if (recordingsQuery.isError) {
    return (
      <Notice icon="alert" role="alert" tone="error">
        {recordingsQuery.error.message}
      </Notice>
    );
  }

  const recordings = recordingsQuery.data;

  if (recordings.length === 0) {
    return (
      <Notice role="status">
        No recordings yet. Capture one on the Voice page, then come back to
        analyze it.
      </Notice>
    );
  }

  return (
    <Tabs defaultValue="signals">
      <TabsList>
        <TabsTrigger value="signals">Signal</TabsTrigger>
        <TabsTrigger value="pronunciation">Pronunciation</TabsTrigger>
      </TabsList>
      <TabsContent value="signals" className="pt-2">
        <SignalAnalysisView
          recordings={recordings}
          recordingId={signalRecordingId}
          onSelect={setSignalRecordingId}
        />
      </TabsContent>
      <TabsContent value="pronunciation" className="pt-2">
        <PronunciationView recordings={recordings} />
      </TabsContent>
    </Tabs>
  );
}

function Notice({
  children,
  icon,
  tone = "muted",
  role,
}: {
  children: ReactNode;
  icon?: "spin" | "alert";
  tone?: "muted" | "error";
  role?: "status" | "alert";
}) {
  const toneClass =
    tone === "error"
      ? "border-destructive/40 text-destructive"
      : "text-muted-foreground";
  return (
    <div
      role={role}
      className={`flex h-40 items-center justify-center gap-2 rounded-lg border border-dashed px-4 text-center text-sm ${toneClass}`}
    >
      {icon === "spin" ? (
        <Loader2 className="size-4 animate-spin" />
      ) : icon === "alert" ? (
        <AlertCircle className="size-4" />
      ) : null}
      <span>{children}</span>
    </div>
  );
}
