import { GestureView } from "@/features/gesture/gesture-view";

export default function GesturePage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Gesture</h1>
        <p className="text-muted-foreground">
          Real-time hand and face landmarks run in your browser with MediaPipe;
          swipes stream to the backend tracker to step spaces left and right.
        </p>
      </div>
      <GestureView />
    </main>
  );
}
