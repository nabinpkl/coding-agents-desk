"use client";

// A tool call an SDK session's permission mode did not settle, and the two answers to it.
//
// A terminal session asks this in its own screen. An SDK session has no screen anybody is looking
// at (ADR-0143), so the runner holds the call open and this is the only place it can be answered:
// a call nobody sees here is a session that looks stuck. The wording is the CLI's own -- the prompt
// sentence, the action's name, why the mode asked -- passed through rather than rebuilt.

import { LoaderCircle } from "lucide-react";
import type { ClaudeSdkApprovalRequest } from "@agentdesk/agent-feed-wire";
import type { SdkSessionHandle } from "@/features/cli-input/useSdkSession";

/** The fields worth showing for the tools that ask most, in the order a reader decides by. */
const SHOWN_FIELDS = ["command", "file_path", "path", "url", "pattern", "plan", "description"] as const;

/** What the call would do, as text: its telling field when it has one, else its whole input. */
export function approvalDetail(input: Record<string, unknown>): string {
  for (const field of SHOWN_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) return value;
  }
  return JSON.stringify(input, null, 2);
}

const BUTTON =
  "flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40";
const PRIMARY = `${BUTTON} bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80`;
const QUIET = `${BUTTON} text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80`;

function ApprovalRequest({ request, session }: { request: ClaudeSdkApprovalRequest; session: SdkSessionHandle }) {
  const name = request.displayName ?? request.toolName;
  const allow = () => void session.decide(request.toolUseId, true);
  const deny = () => void session.decide(request.toolUseId, false);
  // A call the CLI asks not to be approved by one stray press offers the deny as its main action.
  const allowFirst = !request.defaultToNo;
  return (
    <section aria-label={`Claude asks to use ${name}`} className="mb-3 rounded-xl border border-border bg-background">
      <div className="px-3 pt-2">
        <p className="text-(length:--agent-panel-fs-sidebar-body,15px) leading-6 text-foreground">
          {request.title ?? `Claude wants to use ${name}`}
        </p>
        {request.description || request.decisionReason ? (
          <p className="text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            {[request.description, request.decisionReason].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted/50 px-2 py-1.5 font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) whitespace-pre-wrap break-words text-foreground">
          {approvalDetail(request.input)}
        </pre>
      </div>
      <div className="flex items-center justify-end gap-2 px-3 py-2">
        {session.pending ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden /> : null}
        <button type="button" onClick={deny} disabled={session.pending} className={allowFirst ? QUIET : PRIMARY}>
          Deny
        </button>
        <button type="button" onClick={allow} disabled={session.pending} className={allowFirst ? PRIMARY : QUIET}>
          Allow
        </button>
      </div>
    </section>
  );
}

export function SdkApprovalRequests({ session }: { session: SdkSessionHandle }) {
  const approvals = session.state.pending.filter(
    (request): request is ClaudeSdkApprovalRequest => request.kind === "approval",
  );
  if (approvals.length === 0) return null;
  return (
    <>
      {approvals.map((request) => <ApprovalRequest key={request.toolUseId} request={request} session={session} />)}
      {session.error ? (
        <p role="alert" className="mb-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">{session.error}</p>
      ) : null}
    </>
  );
}
