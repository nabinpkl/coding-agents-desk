import { CornerUpLeft, SendHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { DirectoryEntry, Message } from "@agentdesk/agent-feed-wire";
import type { MessagesHandle } from "@/features/messages/useMessages";
import { isCancellable, isUnanswered, messageTime, threadState, threadStateLabel } from "@/features/messages/messageState";
import { recipientGroups, runtimesOf } from "@/features/messages/hubRuntime";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { SidebarError, SidebarStatus } from "@/features/sidebar/SidebarStatusRows";

function otherEntry(message: Message, directory: DirectoryEntry[]): DirectoryEntry | undefined {
  const other = message.from === "human" ? message.to : message.from;
  return directory.find((entry) => entry.address === other);
}

function isReachable(address: string, directory: DirectoryEntry[]): boolean {
  return directory.find((entry) => entry.address === address)?.reachability === "reachable";
}

/**
 * One session's name in the picker, with whether anyone is there to receive it.
 *
 * No runtime here. The runtime is on the thread row, where it is the thing being told apart, and a
 * reader choosing between four sessions of one Bot is choosing between four names, not four
 * providers; repeating "opencode" on all four spends the width the names needed.
 */
function optionLabel(entry: DirectoryEntry): string {
  return entry.reachability === "reachable" ? entry.name : `${entry.name} · no live session`;
}

interface MessagesPanelProps {
  messages: MessagesHandle;
}

/**
 * The owner's message threads with every agent the hub can address.
 *
 * A dense rail, not a chat window. It sits in the same column as the session list, so it is held
 * to the same register: a row is a row, direction is a rule down its edge rather than a coloured
 * bubble, and the only thing that earns emphasis is a thread that is waiting on the owner. A
 * message app's conventions here would be two surfaces wearing one column, and the reader would
 * have to learn which one they were in.
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
  const groups = useMemo(() => recipientGroups(addressable), [addressable]);
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
          <ul role="list" aria-label="Message threads">
            {state.threads.map((thread) => (
              <Thread key={thread[0]!.threadId} thread={thread} directory={directory} messages={messages} />
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={submit} className="shrink-0 border-t border-border">
        <label className="flex min-h-11 items-center gap-2 border-b border-border/80 px-3">
          <span className="shrink-0 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">To</span>
          <select
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-(length:--agent-panel-fs-sidebar-body,15px) outline-none"
          >
            <option value="">Pick a session…</option>
            {groups.map((group) => (
              <optgroup key={group.label ?? "sessions"} label={group.label ?? "Sessions"}>
                {group.entries.map((entry) => (
                  <option key={entry.address} value={entry.address}>
                    {optionLabel(entry)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="flex items-start gap-2 p-3">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Message</span>
            <textarea
              ref={bodyRef}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit(event);
              }}
              rows={2}
              placeholder={to ? (reachable ? "Message" : "Held until a live session") : "Write, then pick a session"}
              className="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-(length:--agent-panel-fs-sidebar-body,15px) outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>
          <button
            type="submit"
            disabled={!to || !body.trim() || sending}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background active:bg-primary/80 disabled:pointer-events-none disabled:opacity-40"
          >
            <SendHorizontal className="size-3.5" aria-hidden />
            Send
          </button>
        </div>
        {failure ? (
          <p role="alert" className="px-3 pb-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
            {failure}
          </p>
        ) : null}
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
  const entry = otherEntry(last, directory);
  const other = entry?.name ?? (last.from === "human" ? last.to : last.from);
  const state = threadState(thread);
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
    <li className="border-b border-border/80">
      <div className="px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-body,15px) font-medium text-foreground">
            {other}
          </span>
          {/* The only emphasised state in the tab. A thread that owes the owner a reply is the one
              thing here that is actionable, so it is the only one that gets ink. A finished thread
              says nothing at all rather than "done": knowing it needs nothing is not worth a
              second line, and a caption on every row is how a list stops being scannable. */}
          {state === "needs-you" ? (
            <span className="flex shrink-0 items-center gap-1 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary">
              <CornerUpLeft className="size-3" aria-hidden />
              {threadStateLabel(state)}
            </span>
          ) : state === "waiting" || state === "closed" ? (
            <span className="shrink-0 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
              {threadStateLabel(state)}
            </span>
          ) : null}
        </div>
        {/*
          The runtime goes on the meta line, not beside the name, which is where `SessionMeta`
          already puts the source badge. Beside the name it was the badge that won: a 70px uppercase
          mono label on a 300px rail truncated "Checking implementation status and revisiting the
          agent messaging plan" to "Checking implementation...", which is the reader losing the
          thing they were scanning for to learn something they could see in the address.
        */}
        <div className="mt-0.5 flex items-center gap-1.5 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
          {entry ? runtimesOf(entry).map((runtime) => <SourceBadge key={runtime} source={runtime} />) : null}
          <span>{messageTime(last.createdAt)}</span>
          {isCancellable(thread) ? (
            <button
              type="button"
              onClick={() => void messages.cancel(last.id)}
              className="ml-auto flex items-center gap-1 rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3" aria-hidden />
              Cancel
            </button>
          ) : null}
        </div>
      </div>

      {/*
        Direction is the rule down the left edge, not a bubble and not a name on every line. The
        rule is the one mark that cannot wrap on a long session name, and it is what lets the
        attribution line be dropped: a row that says who wrote it is a row repeating what its
        edge already said.
      */}
      <ol role="list" className="pb-1">
        {thread.map((message) => (
          <li
            key={message.id}
            className={`border-l-2 py-1.5 pr-3 pl-3 ${
              // Both rules have to be visible or direction stops reading. `border-border` is the
              // divider colour and disappears against the card on a dark surface, which leaves the
              // reader with two unmarked paragraphs; the owner's own words get a quiet neutral
              // rule and an agent's get the accent, which is also the one worth scanning for.
              message.from === "human" ? "border-foreground/20" : "border-primary"
            }`}
          >
            <p className="whitespace-pre-wrap break-words text-(length:--agent-panel-fs-sidebar-body,15px) text-foreground">
              {message.body}
            </p>
            <div className="mt-0.5 flex items-baseline gap-2 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
              <span>{messageTime(message.createdAt)}</span>
              {message.refs.length > 0 ? (
                <span className="min-w-0 truncate">{message.refs.map((ref) => `${ref.app} ${ref.kind} ${ref.id}`).join(", ")}</span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {isUnanswered(thread) ? (
        <form onSubmit={sendReply} className="flex items-start gap-2 px-3 pb-3">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Reply to {other}</span>
            <textarea
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              rows={1}
              className="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-(length:--agent-panel-fs-sidebar-body,15px) outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>
          <button
            type="submit"
            disabled={!reply.trim() || sending}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-input px-2.5 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background active:bg-muted/80 disabled:pointer-events-none disabled:opacity-40"
          >
            <CornerUpLeft className="size-3.5" aria-hidden />
            Reply
          </button>
        </form>
      ) : null}
      {failure ? (
        <p role="alert" className="px-3 pb-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
          {failure}
        </p>
      ) : null}
    </li>
  );
}
