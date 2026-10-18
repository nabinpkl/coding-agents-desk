import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DirectoryEntry, Message } from "@agentdesk/agent-feed-wire";
import { MessagesPanel } from "@/features/messages/MessagesPanel";
import { useMessages } from "@/features/messages/useMessages";
import type { HubHandle } from "@/features/activity-feed/data-source/layers/SidecarHub";

afterEach(() => {
  vi.restoreAllMocks();
});

function message(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    threadId: "m1",
    inReplyTo: null,
    from: "human",
    fromKind: "human",
    to: "bot:fixer",
    kind: "request",
    body: "fix the header",
    refs: [],
    hops: 0,
    state: "delivered",
    toSession: "opencode:ses_1",
    deliveredTo: "opencode:ses_1",
    deliveredAt: "2026-09-25T09:00:00.000Z",
    answeredBy: null,
    createdAt: "2026-09-25T09:00:00.000Z",
    expiresAt: "2026-10-02T09:00:00.000Z",
    ...over,
  };
}

// A destination is a Bot, and a session is reachable only through the Bot curating it, so each
// session entry carries the address that reaches it and the session it is. Every session gets the
// qualified form, even under a Bot curating one, so no two entries share an address.
const directory: DirectoryEntry[] = [
  {
    address: "human",
    session: null,
    name: "owner",
    machine: null,
    reachability: "reachable",
    lastSeenAt: null,
    related: [],
    cwd: null,
  },
  {
    address: "bot:fixer",
    session: null,
    name: "Site fixer",
    machine: "mac",
    reachability: "reachable",
    lastSeenAt: null,
    related: ["bot:fixer/one", "bot:fixer/two"],
    cwd: "/work/site",
  },
  {
    address: "bot:sleeping",
    session: null,
    name: "Sleeping bot",
    machine: "mac",
    reachability: "offline",
    lastSeenAt: null,
    related: [],
    cwd: "/work/site",
  },
  {
    address: "bot:fixer/one",
    session: "opencode:ses_1",
    name: "OpenCode session",
    machine: "mac",
    reachability: "reachable",
    lastSeenAt: null,
    related: ["bot:fixer"],
    cwd: "/work/site",
  },
  {
    address: "bot:fixer/two",
    session: "opencode:ses_2",
    name: "OpenCode session 2",
    machine: "oracle",
    reachability: "offline",
    lastSeenAt: null,
    related: ["bot:fixer"],
    cwd: "/work/site",
  },
];

function feed(over: Record<string, unknown> = {}): HubHandle {
  return {
    threads: vi.fn(async () => []),
    directory: vi.fn(async () => directory),
    send: vi.fn(async () => message()),
    reply: vi.fn(async () => message({ id: "m2", kind: "reply", from: "human", to: "human", state: "delivered" })),
    cancel: vi.fn(async () => message({ state: "cancelled" })),
    ...over,
  };
}

function Harness({ data }: { data: HubHandle }) {
  return <MessagesPanel messages={useMessages(data)} />;
}

describe("MessagesPanel", () => {
  test("says so when there is nothing to read", async () => {
    render(<Harness data={feed()} />);
    expect(await screen.findByText("No messages yet")).toBeTruthy();
  });

  test("lists a thread under the other side's name, badged with the runtime that answers it", async () => {
    // Scoped to the thread list on purpose. Asserting a bare name used to pass by matching an
    // `<option>` in the recipient picker rather than the thread header, so it was testing the
    // composer it thought it was testing the inbox.
    const data = feed({ threads: vi.fn(async () => [[message({ state: "queued", deliveredTo: null })]]) });
    render(<Harness data={data} />);
    const threads = await screen.findByRole("list", { name: "Message threads" });
    expect(within(threads).getByText("OpenCode session")).toBeTruthy();
    // The runtime comes from the address prefix, and uses the badge the session rows already use.
    expect(within(threads).getByText("OpenCode")).toBeTruthy();
    expect(within(threads).getByText("fix the header")).toBeTruthy();
    expect(within(threads).getByText("waiting for a live session")).toBeTruthy();
  });

  test("a Bot holding sessions from both runtimes is badged with both", async () => {
    const data = feed({
      threads: vi.fn(async () => [
        [
          message({
            id: "b1",
            to: "bot:both/opencode:ses_3",
            toSession: "opencode:ses_3",
            deliveredTo: "opencode:ses_3",
            state: "queued",
          }),
        ],
      ]),
      directory: vi.fn(async () => [
        ...directory,
        {
          address: "bot:both",
          session: null,
          name: "Both runtimes",
          machine: "mac",
          reachability: "reachable",
          lastSeenAt: null,
          related: ["bot:both/opencode:ses_3", "bot:both/claude:ses_4"],
          cwd: "/work/site",
        },
        {
          address: "bot:both/opencode:ses_3",
          session: "opencode:ses_3",
          name: "An opencode run",
          machine: "mac",
          reachability: "reachable",
          lastSeenAt: null,
          related: ["bot:both"],
          cwd: "/work/site",
        },
        {
          address: "bot:both/claude:ses_4",
          session: "claude:ses_4",
          name: "A claude run",
          machine: "mac",
          reachability: "reachable",
          lastSeenAt: null,
          related: ["bot:both"],
          cwd: "/work/site",
        },
      ]),
    });
    render(<Harness data={data} />);
    const threads = await screen.findByRole("list", { name: "Message threads" });
    // A thread is named for the session it reached, and badged for the runtimes of the Bot that
    // curates it. One Bot holding both runtimes is genuinely both, not a guess from the name.
    expect(within(threads).getByText("An opencode run")).toBeTruthy();
    expect(within(threads).getByText("Claude")).toBeTruthy();
  });

  /** The picker's trigger, which stands in for the `<select>` the tests used to drive. */
  function openPicker() {
    fireEvent.click(screen.getByRole("button", { name: /Pick a session/ }));
  }

  test("a session with no live session is named as such, and the message waits rather than failing", async () => {
    const data = feed();
    render(<Harness data={data} />);
    await screen.findByText("No messages yet");
    openPicker();
    const offline = await screen.findByRole("option", { name: /OpenCode session 2/ });
    expect(offline.textContent).toContain("no live session");
    fireEvent.click(offline);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "when you are up" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      // The address sent is the one the hub published for that session, not a session id assembled
      // here: a Bot curating one session gives that session the Bot's own address.
      expect(data.send).toHaveBeenCalledWith({ to: "bot:fixer/two", body: "when you are up", kind: "request" });
    });
  });

  test("the picker offers the sessions of each Bot, and nothing that is not curated", async () => {
    // A Bot is the address, and a session is reachable only through the Bot curating it, so the
    // grouping is the whole address space rather than a convenience. A session the owner has not put
    // in a Bot is not in the directory, and so is not something this picker could deliver to.
    const data = feed({
      directory: vi.fn(async () => [
        {
          address: "human",
          session: null,
          name: "owner",
          machine: null,
          reachability: "reachable",
          lastSeenAt: null,
          related: [],
          cwd: null,
        },
        {
          address: "bot:fixer",
          session: null,
          name: "Site fixer",
          machine: "mac",
          reachability: "reachable",
          lastSeenAt: null,
          related: ["bot:fixer/one", "bot:fixer/two"],
          cwd: "/work/site",
        },
        {
          address: "bot:fixer/one",
          session: "opencode:ses_1",
          name: "Fix the header",
          machine: "mac",
          reachability: "reachable",
          lastSeenAt: null,
          related: ["bot:fixer"],
          cwd: "/work/site",
        },
        {
          address: "bot:fixer/two",
          session: "opencode:ses_2",
          name: "Fix the footer",
          machine: "mac",
          reachability: "offline",
          lastSeenAt: null,
          related: ["bot:fixer"],
          cwd: "/work/site",
        },
        {
          address: "bot:loose",
          session: null,
          name: "Empty bot",
          machine: "mac",
          reachability: "offline",
          lastSeenAt: null,
          related: [],
          cwd: "/work/other",
        },
      ]),
    });
    render(<Harness data={data} />);
    await screen.findByText("No messages yet");
    openPicker();
    const list = await screen.findByRole("listbox", { name: "Sessions to send to" });
    // One section per Bot, and the Bot itself is a heading rather than a choice.
    const sections = within(list)
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"))
      .filter((label): label is string => label === "All bots");
    expect(sections).toEqual(["All bots"]);
    expect(within(list).queryByRole("option", { name: /^Site fixer/ })).toBeNull();
    // A Bot with no member sessions gets no heading, since there is nothing to send to.
    expect(within(list).queryByText(/Empty bot/)).toBeNull();
    // Each session appears once, carrying the address that reaches it.
    expect(within(list).getAllByRole("option", { name: "Fix the header" })).toHaveLength(1);
    expect(within(list).getAllByRole("option", { name: /Fix the footer/ })).toHaveLength(1);
  });

  test("the picker filters on what the reader remembers about a session", async () => {
    const data = feed();
    render(<Harness data={data} />);
    await screen.findByText("No messages yet");
    openPicker();
    const filter = await screen.findByLabelText("Filter sessions");
    // The filter answers to what a reader remembers, which is not only a name: a machine, a
    // directory and a Bot are all things they know, so all of them narrow the list.
    let list = screen.getByRole("listbox", { name: "Sessions to send to" });
    expect(within(list).getAllByRole("option").length).toBe(2);
    // A machine narrows: only the oracle session carries it.
    fireEvent.change(filter, { target: { value: "oracle" } });
    list = screen.getByRole("listbox", { name: "Sessions to send to" });
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    // A Bot's name narrows to everything it curates, which is the question a reader actually has when
    // they remember the agent rather than the run.
    fireEvent.change(filter, { target: { value: "Site fixer" } });
    list = screen.getByRole("listbox", { name: "Sessions to send to" });
    expect(within(list).getAllByRole("option").length).toBe(2);
    // A name narrows to the one session carrying it.
    fireEvent.change(filter, { target: { value: "OpenCode session 2" } });
    list = screen.getByRole("listbox", { name: "Sessions to send to" });
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    // And a directory, which both of these sessions run in.
    fireEvent.change(filter, { target: { value: "work/site" } });
    list = screen.getByRole("listbox", { name: "Sessions to send to" });
    expect(within(list).getAllByRole("option").length).toBe(2);
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(screen.getByText(/No session matches/)).toBeTruthy();
  });

  test("the keyboard walks the rows and Enter takes the active one", async () => {
    const data = feed();
    render(<Harness data={data} />);
    await screen.findByText("No messages yet");
    openPicker();
    const list = await screen.findByRole("listbox", { name: "Sessions to send to" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(list.getAttribute("aria-activedescendant")).not.toBeNull();
    fireEvent.keyDown(list, { key: "Enter" });
    // Enter chooses, which sets the recipient; it does not send, because the body is still empty.
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Sessions to send to" })).toBeNull();
    });
    expect(data.send).not.toHaveBeenCalled();
  });

  test("one frame of a collapsed layout does not close the picker, but a settled one does", async () => {
    // A reflow, a scrollbar or a rail drag can measure an ancestor at nothing for a single frame
    // on the way to somewhere visible. Closing on that frame lost a half-typed filter.
    const data = feed();
    render(<Harness data={data} />);
    await screen.findByText("No messages yet");
    openPicker();
    await screen.findByRole("listbox", { name: "Sessions to send to" });
    const trigger = screen.getByRole("button", { name: /Pick a session/ });
    const real = trigger.getBoundingClientRect;
    // Hold the animation frames instead of waiting on a clock, so the two halves of the rule are
    // each observed rather than raced against.
    const frames: FrameRequestCallback[] = [];
    const realRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      frames.push(callback);
      return 0;
    };
    // Something has to actually clip, or the walk finds no clipping ancestor and every reading
    // counts as visible, which would make the whole test pass without testing anything. The
    // longhand, because a stylesheet engine that does not expand the `overflow` shorthand reports
    // an empty `overflowY` for it and the walk skips the ancestor. And a box with area, because an
    // ancestor measuring no area is exactly the transient this rule now ignores.
    const clipper = trigger.closest("form")?.parentElement;
    if (!clipper) throw new Error("no ancestor to make clip");
    const previousClip = clipper.style.overflowY;
    const previousRect = clipper.getBoundingClientRect;
    clipper.style.overflowY = "auto";
    clipper.getBoundingClientRect = () =>
      ({ top: 0, bottom: 800, left: 0, right: 340, width: 340, height: 800 }) as DOMRect;
    const offScreen = { top: 900, bottom: 944, left: 36, right: 327, width: 291, height: 44 } as DOMRect;
    try {
      trigger.getBoundingClientRect = () => offScreen;
      fireEvent.scroll(trigger);
      // Still open: the reading is not the decision, the settled one is.
      expect(screen.getByRole("listbox", { name: "Sessions to send to" })).toBeTruthy();
      // The layout settles back to a trigger that is on screen, so the panel survives.
      trigger.getBoundingClientRect = real;
      frames.splice(0).forEach((frame) => frame(0));
      expect(screen.getByRole("listbox", { name: "Sessions to send to" })).toBeTruthy();
      // Still out of sight once settled: now it closes, rather than floating over content it has
      // nothing to do with.
      trigger.getBoundingClientRect = () => offScreen;
      fireEvent.scroll(trigger);
      frames.splice(0).forEach((frame) => frame(0));
      await waitFor(() => {
        expect(screen.queryByRole("listbox", { name: "Sessions to send to" })).toBeNull();
      });
    } finally {
      globalThis.requestAnimationFrame = realRaf;
      clipper.style.overflowY = previousClip;
      clipper.getBoundingClientRect = previousRect;
    }
  });

  test("a resize re-places the picker instead of throwing away what was typed into it", async () => {
    // The trigger is the composer's own row, so no scroll can carry it away. Closing on resize
    // lost the reader's filter on every window change, which is a thing a person does while
    // narrowing sixty rows.
    const data = feed();
    render(<Harness data={data} />);
    await screen.findByText("No messages yet");
    openPicker();
    const filter = await screen.findByLabelText("Filter sessions");
    fireEvent.change(filter, { target: { value: "session 2" } });
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("listbox", { name: "Sessions to send to" })).toBeTruthy();
    expect((filter as HTMLInputElement).value).toBe("session 2");
  });

  test("Escape closes the picker without choosing, and the trigger is still there", async () => {
    const data = feed();
    render(<Harness data={data} />);
    await screen.findByText("No messages yet");
    openPicker();
    const list = await screen.findByRole("listbox", { name: "Sessions to send to" });
    fireEvent.keyDown(list, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Sessions to send to" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: /Pick a session/ })).toBeTruthy();
  });

  test("a finished thread claims nothing about its state", async () => {
    // The bug this pins: the thread ended on the agent's reply, which is `delivered` to the owner,
    // so reading the last message's state announced a thread that had been answered for an hour
    // as "delivered" and made it look identical to one still waiting on a live session. A finished
    // thread now says nothing, because there is no state left to report.
    const data = feed({
      threads: vi.fn(async () => [
        [
          message({ id: "r1", from: "human", kind: "request", state: "answered" }),
          message({
            id: "r2",
            from: "opencode:ses_1",
            fromKind: "agent",
            kind: "reply",
            to: "human",
            state: "delivered",
            body: "HUB-OK",
          }),
        ],
      ]),
    });
    render(<Harness data={data} />);
    await screen.findByText("HUB-OK");
    expect(screen.queryByText("delivered")).toBeNull();
    expect(screen.queryByText("needs a reply")).toBeNull();
    // And no reply field, because nothing is owed.
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  test("an unanswered agent question is the one state that asks for something", async () => {
    const data = feed({
      threads: vi.fn(async () => [
        [
          message({
            id: "q1",
            from: "opencode:ses_1",
            fromKind: "agent",
            kind: "request",
            to: "human",
            state: "delivered",
          }),
        ],
      ]),
    });
    render(<Harness data={data} />);
    expect(await screen.findByText("needs a reply")).toBeTruthy();
  });

  test("a queued message can be cancelled, because the reader is the one who gave up on it", async () => {
    const data = feed({ threads: vi.fn(async () => [[message({ state: "queued", deliveredTo: null })]]) });
    render(<Harness data={data} />);
    await screen.findByText("waiting for a live session");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(data.cancel).toHaveBeenCalledWith("m1");
    });
  });

  test("the hub being unreachable says why, rather than showing an empty inbox", async () => {
    const data = feed({
      threads: vi.fn(async () => {
        throw new Error('{"error":{"message":"hub not configured"}}');
      }),
    });
    render(<Harness data={data} />);
    expect(await screen.findByText(/hub not configured/)).toBeTruthy();
  });
});
