import { GitFork } from "lucide-react";

/**
 * What a fork shows before it has said anything.
 *
 * Empty on purpose, and not a loading state: a forked session has no transcript to read because
 * the CLI writes none until its first turn. Measured -- resuming a fork loaded 255k tokens of
 * context and created no file at all; the file appeared only after one message. So the terminal
 * below is the whole session until then, and this says so rather than spinning on a transcript
 * that is not coming.
 */
export function ForkedSessionView(
  { title, rewindFailed, onClose }:
    { title: string; rewindFailed?: string; onClose: () => void },
) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground">
      <GitFork className="size-5" aria-hidden />
      <p className="max-w-prose">
        Forked from <span className="font-medium text-foreground">{title}</span>. Its transcript
        appears here once you send the first message in the terminal below.
      </p>
      {/* The fork asked to start at a message and did not get there. It is running either way, so
          this says which of the two it is rather than leaving the reader to find out by reading
          a transcript that turns out to hold the whole conversation. */}
      {rewindFailed ? (
        <p className="max-w-prose text-amber-600 dark:text-amber-400">
          It is holding the whole conversation: it could not be moved back to that message
          &mdash; {rewindFailed}.
        </p>
      ) : null}
      <button
        type="button"
        onClick={onClose}
        className="min-h-9 cursor-pointer rounded-lg border border-border px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
      >
        Close fork
      </button>
    </div>
  );
}
