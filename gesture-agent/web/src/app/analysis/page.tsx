import { AnalysisPanel } from "@/features/analysis/analysis-panel";

export default function AnalysisPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Analysis</h1>
        <p className="text-muted-foreground">
          Inspect a saved recording&apos;s signal curves, or compare two takes
          to see how closely their pronunciation aligns.
        </p>
      </header>
      <AnalysisPanel />
    </main>
  );
}
