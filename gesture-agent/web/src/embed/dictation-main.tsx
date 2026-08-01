import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/app/globals.css";
import "./dictation.css";
import { DictationMini } from "@/features/voice/components/dictation-mini";

// DictationMini shares useVoiceSession with the full panel. That hook
// invalidates the durable recordings query when the Python sidecar completes,
// so this standalone Vite entry needs its own Query provider even though it
// never renders the recordings library itself.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        <DictationMini />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
