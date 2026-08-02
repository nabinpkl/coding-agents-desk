/**
 * Root of the embedded InteractionPanel bundle: the one webview AgentDesk mounts
 * in the macOS gesture window and the iOS half-screen panel. It hosts both
 * interaction surfaces authored in this repo — gesture (three-finger swipe ->
 * space step) and voice (live capture + transcript) — behind a lightweight
 * toggle, so the native host ships a single bundle and picks the initial view.
 *
 * Gesture is the default view (it is what the current macOS/iOS mounts are wired
 * for); the host can open straight to voice by injecting `flags.voiceFirst`.
 * Voice needs the TanStack Query cache (recordings truth), so the whole tree is
 * wrapped once in a QueryClientProvider; gesture ignores it.
 */

"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Hand, Mic } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { GestureView } from "@/features/gesture/gesture-view";
import { VoicePanel } from "@/features/voice/voice-panel";
import { getHostConfig } from "@/lib/host-bridge";
import { subscribeInteractionDelivery } from "@/lib/interaction-delivery";
import { RECORDINGS_QUERY_KEY } from "@/features/voice/use-recordings";

type InteractionView = "gesture" | "voice";

function initialView(): InteractionView {
  return getHostConfig()?.flags?.voiceFirst ? "voice" : "gesture";
}

function ViewToggle({
  view,
  onChange,
}: {
  view: InteractionView;
  onChange: (next: InteractionView) => void;
}) {
  return (
    <div className="mb-4 inline-flex gap-1 rounded-lg bg-muted/50 p-1">
      <Button
        size="sm"
        variant={view === "gesture" ? "default" : "ghost"}
        onClick={() => onChange("gesture")}
      >
        <Hand />
        Gesture
      </Button>
      <Button
        size="sm"
        variant={view === "voice" ? "default" : "ghost"}
        onClick={() => onChange("voice")}
      >
        <Mic />
        Voice
      </Button>
    </div>
  );
}

export function InteractionApp() {
  const [view, setView] = useState<InteractionView>(initialView);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 60_000, refetchOnWindowFocus: false },
        },
      }),
  );

  useEffect(
    () =>
      subscribeInteractionDelivery<{
        readonly view: InteractionView;
        readonly refreshRecordings?: boolean;
      }>("interactionView", ({ view: nextView, refreshRecordings }) => {
        if (nextView !== "voice" && nextView !== "gesture") return;
        setView(nextView);
        if (nextView === "voice" && refreshRecordings) {
          void queryClient.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY });
        }
      }),
    [queryClient],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <div className="mx-auto max-w-5xl p-4">
        <ViewToggle view={view} onChange={setView} />
        {/* Both views stay mounted-on-demand: switching away tears down the
            camera / mic through each feature's own unmount cleanup. */}
        {view === "gesture" ? <GestureView /> : <VoicePanel />}
      </div>
    </QueryClientProvider>
  );
}
