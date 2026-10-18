"use client";

import { useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import type { StaleClaudeSession } from "@agentdesk/agent-feed-wire";
import type { MachineStaleSessions, StaleSessionsHandle } from "@/features/profile/useStaleSessions";
import { useModal } from "@/hooks/dom/overlays";
import { useTimeout } from "@/hooks/useInterval";

/** How long the armed Restart waits for its second press, as the terminal footer's does. */
const CONFIRM_WINDOW_MS = 4_000;

/**
 * Every Claude session, on every machine, that is behind the launch flags or the installed CLI, and
 * the one button that restarts the ones it can, each on its own machine.
 *
 * A list first rather than a menu item that just does it, because "restart everything stale" is
 * a different set every time it is pressed, and the reader is owed the set before agreeing to it:
 * which sessions, why each, and which are being left alone and why. What is left alone is decided
 * by the sidecar from the CLI's own registry -- a turn running, a dialog open, a background shell
 * that would die -- and again by it at the moment of each restart, so this list is what the reader
 * agrees to, never what forces a restart through.
 */
export function StaleSessionsModal({
  open,
  restarts,
  onClose,
}: {
  open: boolean;
  restarts: StaleSessionsHandle;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useModal(dialog, open);

  return (
    <dialog
      ref={dialog}
      aria-label="Restart stale sessions"
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
      className="m-auto max-h-[88dvh] w-[min(40rem,94vw)] overflow-hidden rounded-xl border border-border
        bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/40"
    >
      {open ? <StaleSessionsPanel restarts={restarts} onClose={onClose} /> : null}
    </dialog>
  );
}

/** Restartable now: idle, and launched by the panel, so a restart loses nothing it was given. */
function restartable(session: StaleClaudeSession): boolean {
  return session.activity === "idle" && !session.ownLaunch;
}

/** Why a stale session is being left running, in a few words. */
function leftRunningBecause(session: StaleClaudeSession): string {
  if (session.ownLaunch) return "own launch flags";
  if (session.activity === "busy") return "turn running";
  if (session.activity === "waiting") return "dialog open";
  if (session.activity === "shell") return "background shell";
  return "state unknown";
}

/** Restartable now, per machine, in the order the list shows them. */
function readySessions(machine: MachineStaleSessions): StaleClaudeSession[] {
  return machine.view.kind === "ready" ? machine.view.stale.sessions.filter(restartable) : [];
}

/** The body, exported apart from the dialog because jsdom cannot open a `<dialog>`. */
export function StaleSessionsPanel({
  restarts,
  onClose,
}: {
  restarts: StaleSessionsHandle;
  onClose: () => void;
}) {
  const { machines } = restarts;
  const [armed, setArmed] = useState(false);
  // A machine label only when there is more than one machine to tell apart.
  const labelled = machines.length > 1;
  const ready = new Map(machines.map((machine) => [machine.key, readySessions(machine)]));
  const total = [...ready.values()].reduce((sum, sessions) => sum + sessions.length, 0);
  const restarting = machines.reduce(
    (sum, { action }) => sum + (action.kind === "restarting" ? action.count : 0),
    0,
  );
  const running = restarting > 0;
  const lone = machines.length === 1 && machines[0]!.view.kind === "ready" ? machines[0]!.view.stale : null;

  useTimeout(() => setArmed(false), armed ? CONFIRM_WINDOW_MS : null);

  const press = (): void => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    restarts.restart(new Map([...ready].map(([key, sessions]) => [key, sessions.map((session) => session.sessionId)])));
  };

  return (
    <div className="flex max-h-[88dvh] flex-col">
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Restart stale sessions</h2>
        {lone?.installedVersion ? (
          <p className="shrink-0 font-mono text-xs text-muted-foreground">installed {lone.installedVersion}</p>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground
            transition-colors hover:bg-muted hover:text-foreground active:bg-muted/70
            focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={press}
          disabled={running || total === 0}
          className={
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors "
            + "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary "
            + "disabled:cursor-not-allowed disabled:opacity-50 "
            + (armed
              ? "bg-destructive/15 text-destructive hover:bg-destructive/25 active:bg-destructive/30"
              : "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80")
          }
        >
          <RotateCcw className={`size-3.5 ${running ? "motion-safe:animate-spin" : ""}`} aria-hidden />
          {running ? `Restarting ${restarting}` : armed ? `Press again to restart ${total}` : `Restart ${total}`}
        </button>
        <button
          type="button"
          onClick={restarts.load}
          disabled={running}
          className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors
            hover:bg-muted hover:text-foreground active:bg-muted/70 focus-visible:outline-2
            focus-visible:-outline-offset-2 focus-visible:outline-primary
            disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
        >
          Refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {machines.map((machine) => (
          <MachineSection key={machine.key} machine={machine} labelled={labelled} ready={ready.get(machine.key) ?? []} />
        ))}
      </div>
    </div>
  );
}

/** One machine's outcome and list, under its name when there is more than one machine. */
function MachineSection({
  machine,
  labelled,
  ready,
}: {
  machine: MachineStaleSessions;
  labelled: boolean;
  ready: StaleClaudeSession[];
}) {
  const { view } = machine;
  const stale = view.kind === "ready" ? view.stale : null;
  const installed = stale?.installedVersion ?? null;
  const leftRunning = stale?.sessions.filter((session) => !restartable(session)) ?? [];
  const body = view.kind === "loading" || view.kind === "idle" ? (
    <p className="px-3 py-3 text-sm text-muted-foreground">Reading sessions…</p>
  ) : view.kind === "failed" ? (
    <p role="alert" className="px-3 py-3 text-sm text-destructive">Could not list sessions: {view.message}</p>
  ) : stale && stale.sessions.length === 0 ? (
    <p className="px-3 py-3 text-sm text-muted-foreground">Every session runs the current launch flags and CLI.</p>
  ) : (
    <>
      <SessionGroup title="Will restart" sessions={ready} installed={installed} />
      <SessionGroup title="Left running" sessions={leftRunning} installed={installed} because={leftRunningBecause} />
    </>
  );
  if (!labelled) {
    return (
      <>
        <Outcome action={machine.action} />
        {body}
      </>
    );
  }
  return (
    <section aria-label={machine.label} className="border-b-4 border-border/60 last:border-b-0">
      <h3 className="flex items-baseline gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-sm font-semibold">
        <span className="min-w-0 flex-1 truncate">{machine.label}</span>
        {installed ? <span className="shrink-0 font-mono text-xs font-normal text-muted-foreground">installed {installed}</span> : null}
      </h3>
      <Outcome action={machine.action} />
      {body}
    </section>
  );
}

function SessionGroup({
  title,
  sessions,
  installed,
  because,
}: {
  title: string;
  sessions: StaleClaudeSession[];
  installed: string | null;
  because?: (session: StaleClaudeSession) => string;
}) {
  if (sessions.length === 0) return null;
  return (
    <section aria-label={title}>
      <h4 className="sticky top-0 border-b border-border bg-card px-3 py-1.5 text-xs font-normal text-muted-foreground">
        {title} <span className="tabular-nums">{sessions.length}</span>
      </h4>
      <ul>
        {sessions.map((session) => (
          <li key={session.sessionId} className="flex min-h-9 items-center gap-2 border-b border-border/60 px-3 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate" title={session.sessionId}>{session.name ?? session.sessionId}</span>
            {session.reasons.map((reason) => (
              <span key={reason} className="shrink-0 rounded border border-border px-1.5 font-mono text-[10px] text-muted-foreground">
                {reason === "update" ? `${session.version ?? "?"} → ${installed ?? "?"}` : "old flags"}
              </span>
            ))}
            {because ? (
              <span className="w-28 shrink-0 text-right text-xs text-amber-600 dark:text-amber-400">{because(session)}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What the last restart did, one line, with every session it did not restart named under it. */
function Outcome({ action }: { action: MachineStaleSessions["action"] }) {
  if (action.kind === "failed") {
    return (
      <p role="alert" className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        Restart failed: {action.message}
      </p>
    );
  }
  if (action.kind !== "done") return null;
  const restarted = action.results.filter((result) => result.outcome.kind === "restarted").length;
  const others = action.results.filter((result) => result.outcome.kind !== "restarted");
  return (
    <div role="status" className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 text-xs">
      <p>Restarted {restarted} of {action.results.length}.</p>
      {others.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {others.map(({ sessionId, name, outcome }) => (
            <li key={sessionId} className={outcome.kind === "failed" ? "text-destructive" : "text-muted-foreground"}>
              {name ?? sessionId}: {outcome.kind === "failed" ? `failed, ${outcome.message}` : outcome.kind === "skipped" ? `left running, ${outcome.reason}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
