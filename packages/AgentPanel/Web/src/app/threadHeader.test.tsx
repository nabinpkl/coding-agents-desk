/**
 * The thread's header, its terminal launcher, and the files it can be dropped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, within } from "@testing-library/react";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import { SESSION_MEASURE_CLASS } from "@/features/activity-feed/blocks/ActivityEventHeading";
import {
  deliverTwoBots,
  deliverProjects,
  deliverSessions,
  emitTerminalState,
  openClaudeThread,
  restoreViewport,
  setup,
} from "@/app/agentPanelAppHarness";
import {
  terminalPaneMock,
} from "@/app/agentPanelAppMocks";

vi.mock("@/features/activity-feed/ActivityFeed", async () => {
  const { activityFeedModule } = await import("@/app/agentPanelAppMocks");
  return activityFeedModule();
});
vi.mock("@/features/terminal/AgentTerminalPane", async () => {
  const { terminalPaneModule } = await import("@/app/agentPanelAppMocks");
  return terminalPaneModule();
});
vi.mock("@/features/activity-feed/markdown/Markdown", async () => {
  const { markdownModule } = await import("@/app/agentPanelAppMocks");
  return markdownModule();
});
vi.mock("@/features/activity-feed/blocks/diff/DiffBlock", async () => {
  const { diffBlockModule } = await import("@/app/agentPanelAppMocks");
  return diffBlockModule();
});

describe("App shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // The address is app state now -- it names the selected view -- so it has to be reset between
    // tests for the same reason storage does, or one test's choice opens every test after it.
    window.history.replaceState(null, "", "/");
    terminalPaneMock.context = null;
    terminalPaneMock.onState = null;
    terminalPaneMock.composerContext = null;
    terminalPaneMock.composerHasBasis = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    restoreViewport();
  });

  /** The canvas's own list, so a query cannot pick up a matching row in the sidebar instead. */
  const canvas = () => within(screen.getByRole("list", { name: "Bot canvas" }));
  it("gives the thread a header slot for its own controls", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);

    expect(screen.getByTestId("activity-feed")).toHaveAttribute(
      "data-controls-host",
      "attached",
    );
    unmount();
  });

  it("caps and centres the session column, so a wide window is still a readable line", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    mirrorClaudeComposer(transport);

    // Every token of the measure, rather than one of them: the question this answers is whether the
    // column still carries the cap at all, so a number chosen later is free and dropping the cap is
    // not. A line across a whole window carried 120 characters of body prose at 1440 with the
    // sidebar open, which is the width of a sentence nobody finishes.
    const column = sessionCard();
    for (const token of SESSION_MEASURE_CLASS.split(" ")) {
      expect(column.className).toContain(token);
    }
    unmount();
  });

  it("drops the centring spacer so a long title uses the full row", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);

    // The spacer opposite the back button existed only to centre the title, and
    // cost it 36px plus a gap -- enough to truncate real session titles.
    const heading = screen.getByRole("heading", { level: 1 });
    const header = heading.parentElement!;
    const emptySpacers = [...header.children].filter(
      (child) => child.tagName === "DIV" && child.getAttribute("aria-hidden") === "true",
    );
    expect(emptySpacers).toHaveLength(0);
    expect(heading.className).toContain("flex-1");
    unmount();
  });

  it("announces terminal progress without spending a row on it", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    // Progress and ready are carried by the header icon; the sentence is for
    // assistive tech only. A permanent 45px band for one button is what this
    // replaced.
    expect(screen.getByRole("status")).toHaveClass("sr-only");

    emitTerminalState({
      kind: "ready",
      descriptor: {
        terminalId: "terminal-1",
        ptySessionName: "agent-resume-claude-sid-claude-01",
        pid: 42,
        columns: 80,
        rows: 24,
      },
    });
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    unmount();
  });

  it("keeps failure and exit visible, because those need reading", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    emitTerminalState({ kind: "error", message: "the session is active elsewhere" });
    expect(screen.getByRole("status")).not.toHaveClass("sr-only");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Claude terminal unavailable: the session is active elsewhere",
    );
    unmount();
  });

  it("shows the terminal launcher only on a thread", () => {
    const { transport, unmount } = setup();

    expect(screen.queryByRole("button", { name: /open .* terminal/i })).not.toBeInTheDocument();
    deliverProjects(transport);
    deliverSessions(transport);
    expect(screen.queryByRole("button", { name: /open .* terminal/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Session Claude 01"));
    expect(screen.getByRole("button", { name: "Open Claude terminal" })).toBeInTheDocument();
    unmount();
  });

  it("opens with exact context inside the main column and sends no native terminal message", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);

    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    expect(terminalPaneMock.context).toEqual({
      kind: "agent-session",
      projectPath: "/projects/alpha",
      source: "claude",
      sessionId: "sid-claude-01",
    });
    expect(fake.posted.some((message) =>
      (message as { t?: string }).t?.startsWith("agent-terminal-"))).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent("Opening Claude");
    const terminal = screen.getByRole("region", { name: "Claude terminal" });
    // The pane belongs to the session's own column, which fills `main`, rather than being a band
    // of the shell's beneath it. What this guards is unchanged: it is in the content column and
    // not in the sidebar.
    expect(screen.getByRole("main")).toContainElement(terminal);
    const mainColumn = screen.getByRole("main").parentElement!;
    expect(screen.getByLabelText("Agent navigation").parentElement).toContainElement(mainColumn);
    unmount();
  });

  it("updates the band for sidecar error and ended states", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));

    emitTerminalState({ kind: "error", message: "terminal-conflict" });
    expect(screen.getByRole("status")).toHaveTextContent("Claude terminal unavailable: terminal-conflict");

    fireEvent.click(screen.getByRole("button", { name: "Open Claude terminal" }));
    emitTerminalState({ kind: "ended", exitStatus: 0 });
    expect(screen.getByRole("status")).toHaveTextContent("Claude terminal ended");
    expect(screen.getByRole("button", { name: "Open Claude terminal" })).toBeInTheDocument();
    unmount();
  });

  it("puts the thread's own screen above the field, without taking the field away", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);

    // The field is what a session opens with: it is the surface every session has.
    expect(screen.getByLabelText("Claude composer text")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Claude session terminal" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show the terminal" }));

    // The session id, not a pane name. Which tmux pane that is -- the one a live process runs in,
    // or one started to resume the id -- is the sidecar's to answer, and it is the only side that
    // can: the panel would have to ask, and get the same null for a session running outside tmux
    // as for a session not running at all.
    expect(terminalPaneMock.composerContext).toEqual({
      kind: "session-tmux",
      source: "claude",
      sessionId: "sid-claude-01",
    });
    // BOTH. The screen stands ABOVE the field rather than in place of it, which is the whole
    // point: a reader types here and watches their own text arrive in the agent's composer line.
    // Affordable because the pane is a peek rather than a second full-height input surface.
    expect(screen.getByRole("region", { name: "Claude session terminal" })).toBeInTheDocument();
    expect(screen.getByLabelText("Claude composer text")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide the terminal" }));
    expect(screen.queryByRole("region", { name: "Claude session terminal" }))
      .not.toBeInTheDocument();
    expect(screen.getByLabelText("Claude composer text")).toBeInTheDocument();
    unmount();
  });

  // The choice is about ONE session. It was a single flag, and a single flag meant showing the
  // terminal here replaced the field on every other session too -- including the one the reader
  // was about to type into, which is the worst moment to swap a surface out.
  it("shows a terminal on the session it was asked for, and leaves the others on their field", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    fireEvent.click(screen.getByRole("button", { name: "Show the terminal" }));
    expect(screen.getByRole("region", { name: "Claude session terminal" })).toBeInTheDocument();

    // The other session is untouched: no screen of its own, and a control still reading as off.
    fireEvent.click(screen.getByText("Session Codex 01"));
    expect(screen.getByLabelText("Codex composer text")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Codex session terminal" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show the terminal" })).toBeInTheDocument();

    // And coming back finds the screen still standing, which is what remembering it is for.
    fireEvent.click(screen.getByText("Session Claude 01"));
    expect(screen.getByRole("region", { name: "Claude session terminal" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide the terminal" }));
    unmount();
  });

  /**
   * The session this session's composer is mirroring, so the tmux band is the one on screen.
   *
   * That band is the only one with a box an image can go into -- Claude's own composer is what
   * turns a pasted path into an image -- so it is what a drop test has to be standing on.
   */
  /**
   * Reaches for the field, which is what attaches the pane.
   *
   * Reading a thread does not: the stream this opens puts a `tmux pipe-pane` on the session's
   * pane, and a reader who opened a session to look at it has asked for nothing.
   */
  function engageClaudeComposer() {
    act(() => {
      fireEvent.focus(screen.getByLabelText("Claude composer text"));
    });
  }

  /** An engaged session whose pane was looked for and not found. */
  function noPaneForClaudeComposer(transport: FakeHttpTransport) {
    engageClaudeComposer();
    act(() => {
      // One reading of the pane carries both halves: the box, and whatever dialog stands in front
      // of it. A bare composer state is what the sidecar used to send, and nothing reads it now.
      transport.deliver("/composer/stream", {
        composer: { text: null, hint: null, reason: "no-pane", exact: true, commands: [] },
        question: null,
      });
    });
  }

  function mirrorClaudeComposer(transport: FakeHttpTransport) {
    engageClaudeComposer();
    act(() => {
      transport.deliver("/composer/stream", {
        composer: { text: "", hint: null, reason: null, exact: true, commands: [] },
        question: null,
      });
    });
  }

  /** The session's own box: what the card is, from the inside of it. */
  function sessionCard(): HTMLElement {
    const field = screen.getByLabelText("Type into this session's terminal composer");
    const card = field.closest(".session-view-surface");
    if (!(card instanceof HTMLElement)) throw new Error("the session has no card");
    return card;
  }

  function drop(target: HTMLElement, files: File[]) {
    fireEvent.drop(target, { dataTransfer: { files, types: ["Files"] } });
  }

  /**
   * A file held over a box, which is the state the reader is actually in when they need to be
   * told anything. `dropEffect` is writable here the way it is on a real event, because refusing
   * is what the target sets it to.
   */
  function dragOver(target: HTMLElement) {
    fireEvent.dragOver(target, { dataTransfer: { files: [], types: ["Files"], dropEffect: "" } });
  }

  // The whole session takes the image, not the little box at the bottom of it. A reader aiming a
  // file at a session is aiming at the session, and on the canvas the field is a thin strip on a
  // card that may be showing its terminal instead.
  it("takes an image dropped anywhere on the session, once", async () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    mirrorClaudeComposer(transport);

    await act(async () => {
      drop(sessionCard(), [new File(["png"], "shot.png", { type: "image/png" })]);
    });

    // Exactly one. The composer box used to carry its own copy of these handlers, and a drop that
    // landed on it would now be taken by the box AND again by the card it bubbled up to, which
    // puts the same image in the composer twice.
    const drops = transport.requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/composer/image")
    );
    expect(drops).toHaveLength(1);
    expect(drops[0]!.path).toContain("sid-claude-01");
    unmount();
  });

  // A session with no box to put one in REFUSES the file rather than ignoring it. Ignoring is not
  // the safe option it reads as: without `onDragOver` calling `preventDefault` no `drop` event
  // fires at all and the file becomes the browser's to handle, so the page that declined to take
  // it is also the page that cannot decline it.
  it("refuses the file, and sends nothing, once the session is known to have no pane", async () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    noPaneForClaudeComposer(transport);

    const field = screen.getByLabelText("Claude composer text");
    const card = field.closest(".session-view-surface");
    if (!(card instanceof HTMLElement)) throw new Error("the session has no card");
    await act(async () => {
      drop(card, [new File(["png"], "shot.png", { type: "image/png" })]);
    });

    expect(transport.requests.filter((request) => request.path.endsWith("/composer/image")))
      .toHaveLength(0);
    unmount();
  });

  // The reported bug. There WAS an indication and it was drawn every time: `ring-inset` on the
  // session's own root, which its transcript -- `flex-1 ... bg-background`, flush to three edges --
  // then painted over, because an inset box-shadow paints below its element's descendants. So the
  // regression this guards is not "an indication exists" but "nothing can paint over it": the
  // overlay must be a child of the box that owns the drop, after everything else in it.
  it("shows the overlay over the whole box, where no child can paint on top of it", async () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    mirrorClaudeComposer(transport);

    const card = sessionCard();
    await act(async () => {
      dragOver(card);
    });

    const layer = screen.getByText("Drop to add to the composer").parentElement!;
    // Outside the session's own column, so the transcript's background is not painted after it,
    // and last inside a box that holds the whole session, so nothing else is either. Asserted as
    // that relationship rather than as one named element: which box owns the drop is the surface's
    // business, and the canvas and the thread view answer it differently.
    expect(layer.contains(card)).toBe(false);
    expect(layer.parentElement!.contains(card)).toBe(true);
    expect(layer.parentElement!.lastElementChild).toBe(layer);
    // Transparent to the pointer, or it becomes the `dragleave` target the moment it appears and
    // blinks itself off and on under the cursor.
    expect(layer.className).toContain("pointer-events-none");
    unmount();
  });

  // Refusing has to look different from accepting, or the overlay is just a light that says a drag
  // is happening -- which the reader already knows, because they are doing it.
  it("says it cannot take the file, rather than inviting a drop it will drop on the floor", async () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    noPaneForClaudeComposer(transport);

    const field = screen.getByLabelText("Claude composer text");
    const card = field.closest(".session-view-surface");
    if (!(card instanceof HTMLElement)) throw new Error("the session has no card");
    await act(async () => {
      dragOver(card);
    });

    expect(screen.getByText("This session has no composer to drop into")).toBeInTheDocument();
    expect(screen.queryByText("Drop to add to the composer")).not.toBeInTheDocument();
    unmount();
  });

  // A collapsed card is a name and a dot, and it is most of what a canvas is. The session's own
  // view is not mounted under it at all, so the old handlers could not have been there -- and this
  // is the case where the reader is least likely to guess that from looking.
  it("takes the drag on a closed card, and says opening it is what would help", async () => {
    const { transport, unmount } = setup();
    deliverProjects(transport);
    deliverSessions(transport);
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    deliverTwoBots(transport);

    const row = canvas().getByRole("button", { name: /^Session Claude 01/ });
    const box = row.closest("li")?.firstElementChild;
    if (!(box instanceof HTMLElement)) throw new Error("the card has no box");
    await act(async () => {
      dragOver(box);
    });

    expect(screen.getByText("Open to drop an image")).toBeInTheDocument();
    unmount();
  });

});
