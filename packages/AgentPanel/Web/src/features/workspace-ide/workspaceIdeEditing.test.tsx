// What happens to a reader's unsaved text, which is the half of the IDE that can lose work.
//
// Every case here is one the Swift `WorkspaceIDEController` handled and the first port of it did
// not. They are together in one file because they are one question asked five ways: between the
// keystroke and the bytes landing on disk, what is allowed to throw the text away?

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceSharedState, WorkspaceSummary } from "@agentdesk/agent-feed-wire";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { WorkspaceIdeSurface } from "@/features/workspace-ide/WorkspaceIdeSurface";

// The terminal pane is a whole other surface with an xterm inside it; this file is about the editor.
vi.mock("@/features/workspace-ide/WorkspaceTerminal", () => ({
  WorkspaceTerminal: ({ workspacePath }: { workspacePath: string }) => (
    <div data-testid="terminal" data-path={workspacePath} />
  ),
}));

const WORKSPACE: WorkspaceSummary = { id: "w-1", name: "Project", root: "/projects/thing" };
const OPEN_STATE: WorkspaceSharedState = {
  workspaceId: "w-1",
  revision: 1,
  orderedOpenPaths: ["notes.txt"],
  expandedDirectoryPaths: [],
  previewPath: null,
};

const feed = {} as SidecarDataSource;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.useRealTimers());

function fileBody(revision: string, text: string) {
  return JSON.stringify({
    file: { workspaceId: "w-1", path: "notes.txt", kind: "text", revision, text },
  });
}

const CONFLICT = JSON.stringify({
  conflict: { workspaceId: "w-1", path: "notes.txt", currentRevision: "rev-2" },
});

/** Mounted with notes.txt open and read, sitting in the editor with the caret in it. */
async function editing(): Promise<FakeHttpTransport> {
  const transport = new FakeHttpTransport();
  transport.responses.set("GET /api/workspaces", {
    status: 200,
    body: JSON.stringify({ workspaces: [WORKSPACE] }),
  });
  transport.responses.set("GET /api/workspaces/w-1/file?path=notes.txt", {
    status: 200,
    body: fileBody("rev-1", "hello"),
  });
  transport.responses.set("POST /api/workspaces/w-1/state", {
    status: 200,
    body: JSON.stringify({ state: OPEN_STATE }),
  });
  transport.responses.set("POST /api/workspaces/w-1/file", {
    status: 200,
    body: JSON.stringify({ written: { workspaceId: "w-1", path: "notes.txt", revision: "rev-2" } }),
  });
  render(<WorkspaceIdeSurface transport={transport} feed={feed} />);
  await waitFor(
    () => expect(transport.subscriptions.length).toBeGreaterThan(0),
    // Generous on purpose: this gates every test in the file, and the default second is not enough
    // when the whole suite is running. What it waits for is a promise chain, not a duration.
    { timeout: 10_000 },
  );
  act(() => {
    transport.deliver("/api/workspaces/w-1/stream", { type: "sharedState", state: OPEN_STATE });
  });
  await waitFor(() => expect(screen.getByLabelText("Edit notes.txt")).toHaveValue("hello"));
  return transport;
}

const writes = (transport: FakeHttpTransport) =>
  transport.requests.filter((request) => request.path === "/api/workspaces/w-1/file");

const type = (text: string) =>
  fireEvent.change(screen.getByLabelText("Edit notes.txt"), { target: { value: text } });

/**
 * These tests drive several seconds of autosave and draft timers each, so the default per-test
 * budget is not a deadline they should be measured against -- it is shorter than what they
 * deliberately simulate once the rest of the suite is competing for the machine.
 */
const BUDGET_MS = 30_000;

/** Long enough for the autosave delay and the promises behind it. */
async function settle(ms = 3000) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

it("writes an edit before letting its tab close, instead of dropping it", async () => {
  // A tab closed inside the autosave delay used to take the last keystrokes with it: the timer was
  // left to fire against a file that had already been deleted from state, so it wrote nothing and
  // said nothing. The Swift deferred the close until the write landed (`pendingClosePaths`).
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const transport = await editing();
  type("hello world");

  fireEvent.click(screen.getByRole("button", { name: "Close notes.txt" }));
  await settle();

  expect(writes(transport).map((request) => (request.body as { text: string }).text))
    .toContain("hello world");
}, BUDGET_MS);

it("refuses to close a conflicted tab, because that is the one close with nothing behind it", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const transport = await editing();
  transport.responses.set("POST /api/workspaces/w-1/file", { status: 409, body: CONFLICT });
  type("mine");
  await settle();
  await waitFor(() => expect(screen.getByRole("button", { name: /Keep mine/i })).toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: "Close notes.txt" }));
  await settle();

  expect(await screen.findByText(/Resolve the file conflict/i)).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Open notes.txt" })).toBeInTheDocument();
}, BUDGET_MS);

it("keeps my version by writing it against the revision it just fetched", async () => {
  // Resolving a conflict has to re-base first: the draft's revision is stale by definition once a
  // conflict has been reported. The port fetched the new revision and then asked a save to read it
  // back out of state that had not re-rendered, so it wrote nothing at all and the conflict bar
  // stayed up until the reader typed another character.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const transport = await editing();
  transport.responses.set("POST /api/workspaces/w-1/file", { status: 409, body: CONFLICT });
  type("mine");
  await settle();
  await waitFor(() => expect(screen.getByRole("button", { name: /Keep mine/i })).toBeInTheDocument());

  transport.responses.set("GET /api/workspaces/w-1/file?path=notes.txt", {
    status: 200,
    body: fileBody("rev-2", "theirs"),
  });
  transport.responses.set("POST /api/workspaces/w-1/file", {
    status: 200,
    body: JSON.stringify({ written: { workspaceId: "w-1", path: "notes.txt", revision: "rev-3" } }),
  });

  fireEvent.click(screen.getByRole("button", { name: /Keep mine/i }));
  await settle();

  const attempted = writes(transport).map(
    (request) => request.body as { expectedRevision: string; text: string },
  );
  expect(attempted).toContainEqual(
    expect.objectContaining({ expectedRevision: "rev-2", text: "mine" }),
  );
}, BUDGET_MS);

it("keeps the tab of a file another reader closed while this one had unsaved text in it", async () => {
  // Shared state is shared, so another reader can close a path this reader is mid-edit in. Dropping
  // the tab on that would leave the text in memory with nothing on screen to reach it.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const transport = await editing();
  transport.responses.set("POST /api/workspaces/w-1/file", { status: 409, body: CONFLICT });
  type("mine");
  await settle();

  act(() => {
    transport.deliver("/api/workspaces/w-1/stream", {
      type: "sharedState",
      state: { ...OPEN_STATE, revision: 2, orderedOpenPaths: [] },
    });
  });

  expect(await screen.findByRole("tab", { name: "Open notes.txt" })).toBeInTheDocument();
  expect(screen.getByLabelText("Edit notes.txt")).toHaveValue("mine");
}, BUDGET_MS);

it("does not start a second write while one is in flight, then saves what was typed during it", async () => {
  // Two writes racing would have the second state the revision the first is about to replace, so
  // the reader's own save comes back as somebody else's edit. The Swift's autosave had a `.writing`
  // phase for exactly this; what has to survive it is the text typed while the write was out.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const transport = await editing();

  const release = transport.hold("POST /api/workspaces/w-1/file");

  type("first");
  await settle(1000);
  expect(writes(transport)).toHaveLength(1);

  // Typed while the write is out: no second request may start yet.
  type("first and second");
  await settle(2000);
  expect(writes(transport)).toHaveLength(1);

  await act(async () => {
    release();
  });
  await settle();

  const sent = writes(transport).map((request) => request.body as { text: string; expectedRevision: string });
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ text: "first and second", expectedRevision: "rev-2" });
}, BUDGET_MS);

it("brings a conflicted edit back after a reload, still marked as a conflict", async () => {
  // The reason drafts exist at all. A conflicted file never autosaves -- the write would clobber
  // whoever moved first -- so between the conflict appearing and the reader resolving it, the text
  // is in React state and nowhere else, and a Vite save discards that many times an hour.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const transport = await editing();
  transport.responses.set("POST /api/workspaces/w-1/file", { status: 409, body: CONFLICT });
  type("mine");
  await settle();
  await waitFor(() => expect(screen.getByRole("button", { name: /Keep mine/i })).toBeInTheDocument());

  // The reload: everything in memory goes, and the file on disk has moved on.
  cleanup();
  transport.responses.set("GET /api/workspaces/w-1/file?path=notes.txt", {
    status: 200,
    body: fileBody("rev-2", "theirs"),
  });
  render(<WorkspaceIdeSurface transport={transport} feed={feed} />);
  await waitFor(
    () => expect(transport.subscriptions.length).toBeGreaterThan(0),
    // Generous on purpose: this gates every test in the file, and the default second is not enough
    // when the whole suite is running. What it waits for is a promise chain, not a duration.
    { timeout: 10_000 },
  );
  act(() => {
    transport.deliver("/api/workspaces/w-1/stream", { type: "sharedState", state: OPEN_STATE });
  });

  await waitFor(() => expect(screen.getByLabelText("Edit notes.txt")).toHaveValue("mine"));
  // And still a conflict, not silently dirty: the file moved under the draft while it was gone.
  expect(screen.getByRole("button", { name: /Keep mine/i })).toBeInTheDocument();
}, BUDGET_MS);

it("does not resurrect a draft the reader asked to discard", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const transport = await editing();
  transport.responses.set("POST /api/workspaces/w-1/file", { status: 409, body: CONFLICT });
  type("mine");
  await settle();
  await waitFor(() => expect(screen.getByRole("button", { name: /Use theirs/i })).toBeInTheDocument());

  transport.responses.set("GET /api/workspaces/w-1/file?path=notes.txt", {
    status: 200,
    body: fileBody("rev-2", "theirs"),
  });
  fireEvent.click(screen.getByRole("button", { name: /Use theirs/i }));
  await waitFor(() => expect(screen.getByLabelText("Edit notes.txt")).toHaveValue("theirs"));

  cleanup();
  render(<WorkspaceIdeSurface transport={transport} feed={feed} />);
  await waitFor(
    () => expect(transport.subscriptions.length).toBeGreaterThan(0),
    // Generous on purpose: this gates every test in the file, and the default second is not enough
    // when the whole suite is running. What it waits for is a promise chain, not a duration.
    { timeout: 10_000 },
  );
  act(() => {
    transport.deliver("/api/workspaces/w-1/stream", { type: "sharedState", state: OPEN_STATE });
  });
  await waitFor(() => expect(screen.getByLabelText("Edit notes.txt")).toHaveValue("theirs"));
}, BUDGET_MS);
