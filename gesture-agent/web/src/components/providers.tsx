"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState, type ReactNode } from "react";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * App-wide client providers: TanStack Query (server "truth" cache), next-themes
 * (light/dark), Base UI tooltip context, and the Sonner toaster. Mounted once
 * in the root layout.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster richColors position="bottom-right" />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
