"use client";

// A prompt an agent's extension asked for, rendered inside the session band.

import { useState } from "react";
import type { AgentUiRequest } from "@agentdesk/agent-feed-wire";
import { COLUMN_GUTTER_CLASS } from "@/features/activity-feed/blocks/ActivityEventHeading";
import { runWithFinally } from "@/hooks/state/runWithFinally";

export function ExtensionUISurface({
  requests,
  onRespond,
  onDismiss,
}: {
  requests: AgentUiRequest[];
  onRespond: (request: AgentUiRequest, value: string | boolean | null) => Promise<void>;
  onDismiss: (request: AgentUiRequest) => void;
}) {
  const request = requests.find((candidate) => candidate.expectsResponse) ?? requests.at(-1);
  if (!request) return null;
  if (!request.expectsResponse) {
    return (
      <div
        role="status"
        className={`flex shrink-0 items-start gap-2 border-t border-border bg-muted/40 ${COLUMN_GUTTER_CLASS} py-2 text-(length:--agent-panel-fs-sidebar-meta,13px)`}
      >
        <div className="min-w-0 flex-1">
          <span className="font-medium">{request.title ?? request.key ?? "Pi extension"}</span>
          {request.message ? (
            <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{request.message}</p>
          ) : null}
          {request.lines?.length ? (
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-muted-foreground">
              {request.lines.join("\n")}
            </pre>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onDismiss(request)}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Dismiss extension notice"
        >
          Dismiss
        </button>
      </div>
    );
  }
  return <ExtensionUIPrompt key={request.requestId} request={request} onRespond={onRespond} />;
}

export function ExtensionUIPrompt({
  request,
  onRespond,
}: {
  request: AgentUiRequest;
  onRespond: (request: AgentUiRequest, value: string | boolean | null) => Promise<void>;
}) {
  const [value, setValue] = useState(request.prefill ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const respond = async (response: string | boolean | null) => {
    if (pending) return;
    setPending(true);
    setError(null);
    return runWithFinally(
      async () => {
        try {
          await onRespond(request, response);
        } catch (caught) {
          setError(String((caught as Error).message ?? caught));
        }
      },
      () => setPending(false),
    );
  };
  return (
    <section
      role="dialog"
      aria-label={request.title ?? "Pi extension request"}
      className={`shrink-0 border-t border-primary/30 bg-primary/5 ${COLUMN_GUTTER_CLASS} py-2`}
    >
      <p className="text-(length:--agent-panel-fs-sidebar-body,15px) font-medium">
        {request.title ?? "Pi extension request"}
      </p>
      {request.message ? (
        <p className="mt-1 whitespace-pre-wrap text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          {request.message}
        </p>
      ) : null}
      {request.kind === "select" ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {request.options?.map((option) => (
            <button
              key={option}
              type="button"
              disabled={pending}
              onClick={() => void respond(option)}
              className="rounded-lg border border-border bg-card px-3 py-1.5 hover:bg-muted disabled:opacity-40"
            >
              {option}
            </button>
          ))}
          <button
            type="button"
            disabled={pending}
            onClick={() => void respond(null)}
            className="rounded-lg px-3 py-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      ) : request.kind === "confirm" ? (
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => void respond(false)}
            className="rounded-lg px-3 py-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void respond(true)}
            className="rounded-lg bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40"
          >
            Confirm
          </button>
        </div>
      ) : (
        <form
          className="mt-2 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void respond(value);
          }}
        >
          {request.kind === "editor" ? (
            <textarea
              autoFocus
              disabled={pending}
              rows={4}
              maxLength={50_000}
              value={value}
              placeholder={request.placeholder}
              onChange={(event) => setValue(event.target.value)}
              className="min-w-0 flex-1 resize-y rounded-lg border border-border bg-background px-3 py-2 outline-none focus:border-primary disabled:opacity-40"
            />
          ) : (
            <input
              autoFocus
              disabled={pending}
              maxLength={50_000}
              value={value}
              placeholder={request.placeholder}
              onChange={(event) => setValue(event.target.value)}
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 outline-none focus:border-primary disabled:opacity-40"
            />
          )}
          <button
            type="button"
            disabled={pending}
            onClick={() => void respond(null)}
            className="h-9 rounded-lg px-2 text-muted-foreground hover:bg-muted disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="h-9 rounded-lg bg-primary px-3 text-primary-foreground disabled:opacity-40"
          >
            Submit
          </button>
        </form>
      )}
      {error ? (
        <p role="alert" className="mt-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
