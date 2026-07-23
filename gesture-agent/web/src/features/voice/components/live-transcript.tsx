/**
 * Dumb live-transcript surface. Shows the streaming final text with the still
 * in-flight partial appended in a muted tone. Both are momentum: they exist
 * only during a run and vanish once the persisted recording becomes truth.
 */

"use client";

import { cn } from "@/lib/utils";

interface LiveTranscriptProps {
  readonly partial: string;
  readonly final: string;
  readonly placeholder: string;
  readonly className?: string;
}

export function LiveTranscript({
  partial,
  final,
  placeholder,
  className,
}: LiveTranscriptProps) {
  const hasText = final.length > 0 || partial.length > 0;

  return (
    <div
      className={cn(
        "min-h-24 rounded-lg border border-border bg-muted/30 p-4 text-sm leading-relaxed",
        className,
      )}
      aria-live="polite"
    >
      {hasText ? (
        <p className="whitespace-pre-wrap">
          {final ? <span className="text-foreground">{final}</span> : null}
          {final && partial ? " " : null}
          {partial ? (
            <span className="text-muted-foreground italic">{partial}</span>
          ) : null}
        </p>
      ) : (
        <p className="text-muted-foreground">{placeholder}</p>
      )}
    </div>
  );
}
