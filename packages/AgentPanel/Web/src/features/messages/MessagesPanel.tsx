import { SendHorizonal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { DirectoryEntry, Message } from "@agentdesk/agent-feed-wire";
import type { MessagesHandle } from "@/features/messages/useMessages";
import { SidebarError, SidebarStatus } from "@/features/sidebar/SidebarStatusRows";

/** What one delivery state reads as, in the owner's own terms. */
const STATE_LABEL: Record<Message["state"], string> = {
  queued: "waiting for a live session",
  pushed: "sending",
  delivered: "delivered",
  answered: "answered",
  expired: "expired",
  cancelled: "cancelled",
};

/** The states that are not finished, so the owner can see what is still owed. */
const OPEN_STATES = new Set<Message["state"]>(["queued", "pushed", "delivered"]);

function otherName(message: Message, directory: DirectoryEntry[]): string {
  const other = message.from === "human" ? message.to : message.from;
  return directory.find((entry) => entry.address === other)?.name ?? other;
}

function isReachable(address: string, directory: DirectoryEntry[]): boolean {
  return directory.find((entry) => entry.address === address)?.reachability === "reachable";
}

interface MessagesPanelProps {
  messages: MessagesHandle;
}

/**
 * The owner's message threads with every agent the hub can address.
 *
 * A thread, not a list of messages: the agent's answer arrives as a reply in the same thread, and
 * the answer is the only thing the reader needs beside it, so both live in one column with the
 * reply field at the foot of the thread they belong to. Address selection is a list of names
 * rather than raw addresses, because "AD bot" is what the reader knows and `bot:<uuid>` is not.
 */
export function MessagesPanel({ messages }: MessagesPanelProps) {
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    messages.load();
  }, [messages]);

  const { state, addressable } = messages;
  const directory = state.kind === "ready" ? state.directory : [];
  const bots = useMemo(() => addressable.filter((entry) => entry.address.startsWith("bot:")), [addressable]);
  const sessions = useMemo(() => addressable.filter((entry) => !entry.address.startsWith("bot:")), [addressable]);
  const reachable = to ? isReachable(to, directory) : false;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!to || !body.trim() || sending) return;
    setSending(true);
    setFailure(null);
    try {
      await messages.send({ to, body: body.trim() });
      setBody("");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
      bodyRef.current?.focus();
    }
  };

  if (state.kind === "loading" || state.kind === "idle") return <SidebarStatus>Loading messages…</SidebarStatus>;
  if (state.kind === "error") return <SidebarError message={`Messages unavailable: ${state.message}`} retrying={false} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {state.threads.length === 0 ? (
          <SidebarStatus>No messages yet</SidebarStatus>
        ) : (
          <ul role="list" aria-label="Message threads" className="divide-y divide-border">
            {state.threads.map((thread) => (
              <Thread key={thread[0]!.threadId} thread={thread} directory={directory} messages={messages} />
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={submit} className="shrink-0 space-y-2 border-t border-border p-2">
        <label className="block">
          <span className="sr-only">Send to</span>
          <select
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-background px-2 text-(length:--agent-panel-fs-sidebar-title,15px) outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <option value="">Send to…</option>
            {bots.length > 0 ? (
              <optgroup label="Bots">
                {bots.map((entry) => (
                  <option key={entry.address} value={entry.address}>
                    {entry.name}
                    {entry.reachability === "reachable" ? "" : " (no live session)"}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {sessions.length > 0 ? (
              <optgroup label="Sessions">
                {sessions.map((entry) => (
                  <option key={entry.address} value={entry.address}>
                    {entry.name}
                    {entry.reachability === "reachable" ? "" : " (no live session)"}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
        <div className="flex items-end gap-1.5">
          <label className="block flex-1">
            <span className="sr-only">Message</span>
            <textarea
              ref={bodyRef}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit(event);
              }}
              rows={2}
              placeholder={to ? (reachable ? "Message" : "Held until a live session") : "Pick a recipient first"}
              className="w-full resize-none rounded-lg border border-border bg-background px-2 py-1.5 text-(length:--agent-panel-fs-sidebar-title,15px) outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
              disabled={!to}
            />
          </label>
          <button
            type="submit"
            disabled={!to || !body.trim() || sending}
            aria-label="Send message"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 active:opacity-80 disabled:pointer-events-none disabled:opacity-40"
          >
            <SendHorizonal className="size-4" aria-hidden />
          </button>
        </div>
        {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
      </form>
    </div>
  );
}

function Thread({
  thread,
  directory,
  messages,
}: {
  thread: Message[];
  directory: DirectoryEntry[];
  messages: MessagesHandle;
}) {
  const last = thread[thread.length - 1]!;
  const other = otherName(last, directory);
  const waiting = last.state === "queued";
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const sendReply = async (event: FormEvent) => {
    event.preventDefault();
    if (!reply.trim() || sending) return;
    setSending(true);
    setFailure(null);
    try {
      await messages.reply(last.id, reply.trim());
      setReply("");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <li className="space-y-2 p-2">
      <div className="flex items-baseline justify-between gap-2">
        {/* min-w-0 on the name, not just truncate: without it the flex item's automatic minimum
            is its content width, so a long session name pushed the state badge under itself
            instead of taking the space and truncating. */}
        <span className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold">{other}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{STATE_LABEL[last.state]}</span>
      </div>
      <ol role="list" className="space-y-1.5">
        {thread.map((message) => (
          <li
            key={message.id}
            className={`rounded-lg px-2 py-1.5 text-(length:--agent-panel-fs-body,14px) ${
              message.from === "human" ? "bg-muted/60" : "bg-primary/10"
            }`}
          >
            <p className="whitespace-pre-wrap break-words">{message.body}</p>
            {message.refs.length > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {message.refs.map((ref) => `${ref.app} ${ref.kind} ${ref.id}`).join(", ")}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      {waiting ? (
        <button
          type="button"
          onClick={() => void messages.cancel(last.id)}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
        >
          <X className="size-3" aria-hidden />
          Cancel
        </button>
      ) : null}
      {last.kind === "request" && last.from !== "human" && OPEN_STATES.has(last.state) ? (
        <form onSubmit={sendReply} className="flex items-end gap-1.5">
          <label className="block flex-1">
            <span className="sr-only">Reply to {other}</span>
            <textarea
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              rows={1}
              className="w-full resize-none rounded-lg border border-border bg-background px-2 py-1 text-(length:--agent-panel-fs-body,14px) outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary"
            />
          </label>
          <button
            type="submit"
            disabled={!reply.trim() || sending}
            aria-label={`Send reply to ${other}`}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 active:opacity-80 disabled:pointer-events-none disabled:opacity-40"
          >
            <SendHorizonal className="size-3.5" aria-hidden />
          </button>
        </form>
      ) : null}
      {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
    </li>
  );
}
