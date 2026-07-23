import { VoicePanel } from "@/features/voice/voice-panel";

export default function VoicePage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Voice</h1>
        <p className="text-muted-foreground">
          Live WebSocket ASR: capture your mic, stream PCM to the FastAPI
          backend, and review saved recordings.
        </p>
      </header>
      <VoicePanel />
    </main>
  );
}
