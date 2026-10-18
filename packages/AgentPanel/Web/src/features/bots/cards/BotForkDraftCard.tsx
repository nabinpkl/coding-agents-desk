import { ChevronsUpDown, GitBranch, GitFork, LoaderCircle, Send, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChoiceMenu, type MenuChoice } from "@/features/bots/menus/ChoiceMenu";
import { HARNESSES, type NewSessionHarness } from "@/features/bots/dialogs/BotSessionPickerDialog";
import { COMPOSER_FOOTER_BUTTON_CLASS } from "@/features/session-view/composer/sessionComposerActions";
import { DEFAULT_CARD_SIZE } from "@/features/bots/canvas/botCanvasPreferences";
import type { ForkRequest } from "@/features/bots/dialogs/ForkSessionDialog";

/**
 * A fork onto a Bot that has not started: a card beside its source holding what the dialog used
 * to ask -- the task its name brackets, the first turn, the harness, a worktree -- until the reader
 * sends. Nothing runs before then, because the name is a launch argument and so is the harness.
 */
export interface ForkDraft {
  key: string;
  request: ForkRequest & { botId: string };
}

/** The drafts waiting on a canvas, and what a card does with its own. */
export interface ForkDraftControls {
  drafts: readonly ForkDraft[];
  start: (key: string, choices: ForkChoices) => Promise<string | null>;
  close: (key: string) => void;
}

/** What the reader chose on a fork's draft card. */
export interface ForkChoices {
  task: string;
  brief: string;
  harness: NewSessionHarness;
  worktree: boolean;
}

/** What each harness does with a fork, said where it is chosen. */
const HARNESS_DESCRIPTIONS: Record<NewSessionHarness, string> = {
  "claude-sdk": "Claude through the Agent SDK runner.",
  claude: "Claude in its terminal.",
  opencode: "opencode, handed the conversation as its first turn.",
};

/**
 * A fork onto a Bot, before it starts: a card beside its source holding what the fork dialog used
 * to ask, with the composer its first turn is typed into. Sending starts it; nothing runs before,
 * because the name and the harness are both launch arguments with no second chance.
 *
 * Claude through the SDK by default, as the reader asked. A fork from a message cannot go to
 * opencode: opencode takes the conversation as a handover, which has no message to start at.
 */
export function BotForkDraftCard({
  draft,
  anchor,
  onStart,
  onClose,
}: {
  draft: ForkDraft;
  /** The anchor the fork's name will bracket its task onto: the Bot's next. */
  anchor: string;
  /** Starts it, answering why not when it does not. */
  onStart: (choices: ForkChoices) => Promise<string | null>;
  onClose: () => void;
}) {
  const { request } = draft;
  const source = request.session.title || request.session.sessionId;
  const [task, setTask] = useState("");
  // Seeded with the message a fork from a message starts before, as Claude's own rewind puts it
  // back in the composer: what a reader wants from forking there is usually to send it differently.
  const [brief, setBrief] = useState(request.from?.text ?? "");
  const [harness, setHarness] = useState<NewSessionHarness>("claude-sdk");
  const [worktree, setWorktree] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = useRef<HTMLLIElement>(null);
  // Brought into view as it appears: beside its source, which can be at the edge of the canvas.
  useEffect(() => {
    card.current?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, []);

  const choices: MenuChoice<NewSessionHarness>[] = HARNESSES.map((option) => ({
    value: option.value,
    label: option.label,
    description: HARNESS_DESCRIPTIONS[option.value],
    ...(option.value === "opencode" && request.from
      ? { unavailable: "opencode takes the whole conversation, not from a message." }
      : {}),
  }));
  const harnessLabel = HARNESSES.find((option) => option.value === harness)?.label ?? harness;
  const toOpencode = harness === "opencode";
  // An SDK session is prompted only through a composer, and until its first turn writes a
  // transcript its card has none: started bare, it would sit behind the runner's log with nowhere
  // to type. A terminal fork can be typed into in its pane, and opencode starts on the handover.
  const needsMessage = harness === "claude-sdk" && !brief.trim();

  const start = async () => {
    if (pending || needsMessage) return;
    setPending(true);
    setError(null);
    const refusal = await onStart({ task, brief, harness, worktree: worktree && !toOpencode });
    // A started fork's draft is gone by now; one that was refused keeps everything typed into it.
    if (refusal) {
      setError(refusal);
      setPending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void start();
    }
  };

  return (
    <li ref={card} data-strip-fixed="" className="shrink-0" style={{ width: DEFAULT_CARD_SIZE.width }}>
      <section
        aria-label={`Fork of ${source}`}
        className="flex flex-col overflow-hidden rounded-lg border border-primary"
        style={{ height: DEFAULT_CARD_SIZE.height }}
      >
        <div className="flex shrink-0 items-center gap-2 bg-muted py-2 pr-1.5 pl-3">
          <GitFork className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {/* The name it starts under: the anchor, and the task it brackets, both launch arguments. */}
          <span className="shrink-0 font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) text-foreground">{anchor}</span>
          <input
            value={task}
            onChange={(event) => setTask(event.target.value)}
            disabled={pending}
            maxLength={120}
            placeholder="task"
            aria-label="Task, bracketed after the name"
            className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-(length:--agent-panel-fs-sidebar-meta,13px) outline-none transition-colors placeholder:text-muted-foreground hover:bg-background/60 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Discard this fork"
            title="Discard this fork; nothing has started"
            className={`${COMPOSER_FOOTER_BUTTON_CLASS} text-muted-foreground hover:text-foreground`}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto border-t border-border p-4 text-center text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          <p>
            Fork of <span className="font-medium text-foreground">{source}</span>
          </p>
          {request.from ? (
            <p className="line-clamp-3">
              Starts just before &ldquo;<span className="text-foreground">{request.from.text}</span>&rdquo;
            </p>
          ) : null}
          {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        </div>
        <div className="shrink-0 border-t border-border p-2">
          <div className="rounded-xl border session-view-field shadow-xs transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
            <textarea
              autoFocus
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={pending}
              rows={3}
              placeholder="Its first message"
              aria-label="The fork's first message"
              className="block max-h-40 min-h-12 w-full resize-none bg-transparent px-3 py-2 text-(length:--agent-panel-fs-sidebar-body,15px) leading-6 outline-none disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
          <div className="mt-1 flex items-center gap-0.5 px-1">
            <ChoiceMenu
              label="Harness"
              value={harness}
              choices={choices}
              onChoose={setHarness}
              trigger={{
                ariaLabel: `Runs in ${harnessLabel}, choose another`,
                title: "Choose what the fork runs in",
                className: "flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-foreground outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-primary active:bg-foreground/15 disabled:cursor-not-allowed disabled:opacity-40",
                disabled: pending,
                content: (
                  <>
                    {harnessLabel}
                    <ChevronsUpDown className="size-3 shrink-0 opacity-60" aria-hidden />
                  </>
                ),
              }}
            />
            {toOpencode ? null : (
              <button
                type="button"
                onClick={() => setWorktree((on) => !on)}
                disabled={pending}
                aria-pressed={worktree}
                aria-label={worktree ? "In its own worktree, run in the Bot's checkout instead" : "In the Bot's checkout, run in its own worktree instead"}
                title={worktree ? "Runs in a worktree of its own" : "Runs in the Bot's checkout"}
                className={`${COMPOSER_FOOTER_BUTTON_CLASS} ${worktree ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                <GitBranch className="size-3.5" aria-hidden />
              </button>
            )}
            <button
              type="button"
              onClick={() => void start()}
              disabled={pending || needsMessage}
              aria-label="Start the fork"
              title={needsMessage ? "Write its first message to start it through the SDK" : "Start the fork"}
              className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/50 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            </button>
          </div>
        </div>
      </section>
    </li>
  );
}
