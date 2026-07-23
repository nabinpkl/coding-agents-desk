"use client";

import { MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const noopSubscribe = () => () => {};

/**
 * Returns false during SSR and the first client render, then true once hydrated.
 * Uses useSyncExternalStore so the client/server snapshots differ deterministically
 * without a setState-in-effect (which the react-hooks lint rule forbids).
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * Light/dark theme toggle. Flips between the two explicit themes based on the
 * currently resolved theme. Renders a stable placeholder until mounted to avoid
 * a hydration mismatch, since the resolved theme is only known on the client.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useHydrated();

  const isDark = resolvedTheme === "dark";

  if (!mounted) {
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label="Toggle theme"
        disabled
      >
        <SunIcon />
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
            onClick={() => setTheme(isDark ? "light" : "dark")}
          />
        }
      >
        {isDark ? <MoonIcon /> : <SunIcon />}
      </TooltipTrigger>
      <TooltipContent>
        {isDark ? "Switch to light" : "Switch to dark"}
      </TooltipContent>
    </Tooltip>
  );
}
