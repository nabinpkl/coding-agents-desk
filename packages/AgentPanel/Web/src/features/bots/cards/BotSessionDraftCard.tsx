import { ChevronsUpDown, GitBranch, GitFork, LoaderCircle, Plus, Send, X } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { ChoiceMenu, type MenuChoice } from "@/features/bots/menus/ChoiceMenu";
import { HARNESSES, type NewSessionHarness } from "@/features/bots/dialogs/BotSessionPickerDialog";
import { COMPOSER_FOOTER_BUTTON_CLASS } from "@/features/session-view/composer/sessionComposerActions";
import { DEFAULT_CARD_SIZE } from "@/features/bots/canvas/botCanvasPreferences";
import type { ForkRequest } from "@/features/bots/dialogs/ForkSessionDialog";
import { useMountEffect } from "@/hooks/useMountEffect";

/**
 * A session on a Bot that has not started: a fork beside its source, or a fresh session asked for
 * from the Add sessions dialog. Its card holds the task its name brackets, the first turn, the
 * harness and a worktree until the reader sends. Nothing runs before then, because the name is a
 * launch argument and so is the harness, and a fresh session with no first turn is a `claude` with
 * no transcript, which nothing can resume.
 */
export interface SessionDraft {
  key: string;
  botId: string;
  /** The session it forks, and the message it starts before; absent for a fresh session. */
  fork?: ForkRequest;
  /** What the reader already chose, which the card starts from: the dialog's, for a fresh one. */
  task: string;
  harness: NewSessionHarness;
}

/** The drafts waiting on a canvas, and what a card does with its own. */
export interface SessionDraftControls {
  drafts: readonly SessionDraft[];
  start: (key: string, choices: DraftChoices) => Promise<string | null>;
  close: (key: string) => void;
}

/** What the reader chose on a draft card. */
export interface DraftChoices {
  task: string;
  brief: string;
  harness: NewSessionHarness;
  worktree: boolean;
}

/** What each harness does with a draft, said where it is chosen. */
const HARNESS_DESCRIPTIONS: Record<NewSessionHarness, string> = {
  "claude-sdk": "Claude through the Agent SDK runner.",
  claude: "Claude in its terminal.",
  opencode: "opencode, handed the conversation as its first turn.",
};

/**
 * A session on a Bot, before it starts: a fork beside its source, or a fresh session at the end of
 * its Bot's row, with the composer its first turn is typed into. Sending starts it; nothing runs
 * before, because the name and the harness are both launch arguments with no second chance.
 *
 * A fork runs Claude in its terminal by default, as every new Claude session does; a fresh one
 * starts in the harness the dialog chose. Neither can go to opencode from here when it has no
 * conversation to hand over: a fork from a message has no whole conversation, and a fresh session
 * none at all (the dialog starts opencode itself).
 */
export function BotSessionDraftCard({
  draft,
  anchor,
  onStart,
  onClose,
}: {
  draft: SessionDraft;
  /** The anchor the session's name will bracket its task onto: the Bot's next. */
  anchor: string;
  /** Starts it, answering why not when it does not. */
  onStart: (choices: DraftChoices) => Promise<string | null>;
  onClose: () => void;
}) {
  const { fork } = draft;
  const source = fork ? fork.session.title || fork.session.sessionId : null;
  const noun = fork ? "fork" : "session";
  const [task, setTask] = useState(draft.task);
  // Seeded with the message a fork from a message starts before, as Claude's own rewind puts it
  // back in the composer: what a reader wants from forking there is usually to send it differently.
  const [brief, setBrief] = useState(fork?.from?.text ?? "");
  const [harness, setHarness] = useState<NewSessionHarness>(draft.harness);
  const [worktree, setWorktree] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = useRef<HTMLLIElement>(null);
  // Brought into view as it appears: beside its source, which can be at the edge of the canvas.
  useMountEffect(() => {
    card.current?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
  });

  const choices: MenuChoice<NewSessionHarness>[] = HARNESSES.map((option) => ({
    value: option.value,
    label: option.label,
    description: HARNESS_DESCRIPTIONS[option.value],
    ...(option.value !== "opencode"
      ? {}
      : !fork
        ? { unavailable: "opencode starts from the Add sessions dialog, with nothing to hand over." }
        : fork.from
          ? { unavailable: "opencode takes the whole conversation, not from a message." }
          : {}),
  }));
  const harnessLabel = HARNESSES.find((option) => option.value === harness)?.label ?? harness;
  const toOpencode = harness === "opencode";
  // An SDK session is prompted only through a composer, and until its first turn writes a
  // transcript its card has none: started bare, it would sit behind the runner's log with nowhere
  // to type. A terminal fork can be typed into in its pane, and opencode starts on the handover. A
  // fresh session waits for its first message whatever it runs in, so none is started empty.
  const needsMessage = (!fork || harness === "claude-sdk") && !brief.trim();

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
        aria-label={source === null ? "New session" : `Fork of ${source}`}
        className="flex flex-col overflow-hidden rounded-lg border border-primary"
        style={{ height: DEFAULT_CARD_SIZE.height }}
      >
        <div className="flex shrink-0 items-center gap-2 bg-muted py-2 pr-1.5 pl-3">
          {fork ? (
            <GitFork className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          {/* The name it starts under: the anchor, and the task it brackets, both launch arguments. */}
          <span className="shrink-0 font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) text-foreground">
            {anchor}
          </span>
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
            aria-label={`Discard this ${noun}`}
            title={`Discard this ${noun}; nothing has started`}
            className={`${COMPOSER_FOOTER_BUTTON_CLASS} text-muted-foreground hover:text-foreground`}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto border-t border-border p-4 text-center text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          {source === null ? (
            <p>New session</p>
          ) : (
            <p>
              Fork of <span className="font-medium text-foreground">{source}</span>
            </p>
          )}
          {fork?.from ? (
            <p className="line-clamp-3">
              Starts just before &ldquo;<span className="text-foreground">{fork.from.text}</span>&rdquo;
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
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
              aria-label={`The ${noun}'s first message`}
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
                title: `Choose what the ${noun} runs in`,
                className:
                  "flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-foreground outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-primary active:bg-foreground/15 disabled:cursor-not-allowed disabled:opacity-40",
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
                aria-label={
                  worktree
                    ? "In its own worktree, run in the Bot's checkout instead"
                    : "In the Bot's checkout, run in its own worktree instead"
                }
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
              aria-label={`Start the ${noun}`}
              title={needsMessage ? "Write its first message to start it" : `Start the ${noun}`}
              className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/50 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
              ) : (
                <Send className="size-4" aria-hidden />
              )}
            </button>
          </div>
        </div>
      </section>
    </li>
  );
}
