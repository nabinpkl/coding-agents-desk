// Starting a run from the arena: the lineup it posts, the lanes' harnesses and models, the manager
// it may open with, and the header that waits for a run's first prompt. Split from the surface's
// main suite, which covers reading runs that exist.

import { describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach } from "vitest";
import { ArenaSurface } from "@/features/arena/ArenaSurface";
import type { AgentHttpTransport, TransportResponse } from "@/features/activity-feed/transport/AgentHttpTransport";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { HostActionsClient } from "@/features/activity-feed/data-source/HostActionsClient";

afterEach(() => {
  cleanup();
  // The surface keeps its run in the address, which outlives a test the way it outlives a reload.
  window.history.replaceState(null, "", "/");
});

// The diff viewer measures text on a canvas, which jsdom does not have; the same stub the app's
// own tests use. What is pinned here is which lane a diff lands in, not how the viewer draws it.
vi.mock("@git-diff-view/react", () => ({
  DiffView: () => <div data-testid="diff-view" />,
  DiffModeEnum: { Unified: 1 },
}));

vi.mock("@git-diff-view/file", () => ({
  DiffFile: {
    createInstance: () => ({ initTheme() {}, init() {}, buildUnifiedDiffLines() {} }),
  },
}));

const contestant = (over: Record<string, unknown> = {}) => ({
  contestantId: "c1",
  stance: "for",
  source: "opencode",
  sessionId: "ses-one",
  worktreePath: "/arena/11111111-1111-4111-8111-111111111111/c1",
  status: "closed",
  startedAt: 1,
  closedAt: 3,
  durationMs: 2000,
  error: null,
  contextTokens: 1234,
  costUsd: 0.02,
  filesRead: ["/arena/11111111-1111-4111-8111-111111111111/c1/README.md"],
  filesWritten: [],
  outsideReached: [] as { path: string; how: string; rival: string | null }[],
  gitDiff: null,
  ...over,
});

const run = (over: Record<string, unknown> = {}) => ({
  runId: "11111111-1111-4111-8111-111111111111",
  name: "arena run 1",
  folder: "/arena/arena-run-1",
  prompt: "say one word",
  round: 1,
  repoPath: "/repos/one",
  repoCreated: false,
  baseRef: "HEAD",
  mode: "headless",
  createdAt: 1,
  contestants: [contestant()],
  ...over,
});

/** A transport that answers the arena's own routes and records what was asked of it. */
function harness(
  options: {
    detail?: unknown;
    runs?: unknown[];
    modes?: string[];
    projects?: { projectPath: string }[];
    /** What the sidecar says of a folder; any other is a repository. */
    folders?: Record<string, { repository: boolean; problem: string | null }>;
  } = {},
) {
  const posted: unknown[] = [];
  /** The folders the reader asked to be made repositories. */
  const made: string[] = [];
  const postedTo: string[] = [];
  const asked: string[] = [];
  const transport: AgentHttpTransport = {
    async request(method, path, requestOptions): Promise<TransportResponse> {
      if (method === "GET") asked.push(path);
      if (method === "GET" && path === "/api/agent-sessions/opencode/models") {
        const model = (providerID: string, modelID: string, name: string) => ({
          providerID,
          modelID,
          name,
          contextLimit: null,
          inputCost: null,
          outputCost: null,
        });
        return {
          status: 200,
          body: JSON.stringify({
            models: [model("opencode", "big-pickle", "Big Pickle"), model("opencode-go", "kimi-k2", "Kimi K2")],
          }),
        };
      }
      if (method === "GET" && path.startsWith("/api/arena/code/tree")) {
        return { status: 200, body: JSON.stringify({ tree: [] }) };
      }
      if (method === "GET" && path === "/api/arena/new-run" && options.modes) {
        return {
          status: 200,
          body: JSON.stringify({ modes: options.modes, arenaHome: "/Users/me/.arena", nextName: "arena run 3" }),
        };
      }
      if (method === "GET" && path === "/api/arena/runs") {
        return { status: 200, body: JSON.stringify({ runs: options.runs ?? [] }) };
      }
      if (method === "GET" && path.startsWith("/api/arena/runs/")) {
        return { status: 200, body: JSON.stringify(options.detail ?? run()) };
      }
      if (method === "POST" && path === "/api/arena/folders/repository") {
        const { path: folder } = requestOptions?.body as { path: string };
        made.push(folder);
        options.folders![folder] = { repository: true, problem: null };
        return { status: 200, body: JSON.stringify({ path: folder, repository: true, problem: null }) };
      }
      if (method === "POST" && path === "/api/arena/folders") {
        const { paths } = requestOptions?.body as { paths: string[] };
        const folders = paths.map((one) => ({ path: one, repository: true, problem: null, ...options.folders?.[one] }));
        return { status: 200, body: JSON.stringify({ folders }) };
      }
      if (method === "POST" && path.endsWith("/prompt")) {
        posted.push(requestOptions?.body);
        postedTo.push(path);
        const prompt = (requestOptions?.body as { prompt: string }).prompt;
        return { status: 200, body: JSON.stringify({ ...((options.runs?.[0] as object) ?? run()), prompt }) };
      }
      if (method === "POST") {
        posted.push(requestOptions?.body);
        postedTo.push(path);
        return { status: 201, body: JSON.stringify(run()) };
      }
      return { status: 404, body: "" };
    },
    // The inventory stream answers only a test that names projects, for the repository picker.
    subscribe: (path, handlers) => {
      if (options.projects && path.startsWith("/api/inventory/stream")) {
        const projects = options.projects.map((project) => ({
          displayName: project.projectPath.split("/").at(-1),
          sourceCounts: {},
          sessionCount: 0,
          lastEventAt: 1,
          ...project,
        }));
        queueMicrotask(() => handlers.onMessage(JSON.stringify({ projects })));
      }
      return () => {};
    },
  };
  return { transport, posted, postedTo, asked, made };
}

/**
 * The surface as the tab mounts it. The catalog stream answers nothing here, so a lane shows its
 * not-listed state rather than mounting a whole `SessionView` in jsdom; the lanes themselves are
 * verified in a real browser by `chrome-test/arena-verify.mjs`.
 */
function mount(transport: AgentHttpTransport) {
  const host = {} as HostActionsClient;
  return render(<ArenaSurface transport={transport} feed={new SidecarDataSource(transport)} host={host} />);
}

async function openRun(prompt: string) {
  const row = await screen.findByRole("button", { name: new RegExp(prompt) });
  row.click();
  await screen.findByRole("region", { name: "c1 OpenCode facts" });
}

describe("ArenaSurface new run", () => {
  test("starting a run posts the prompt and the lineup in lane order, then opens the run", async () => {
    const { transport, posted } = harness();
    mount(transport);
    const prompt = screen.getByLabelText("Prompt every contestant gets");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(prompt, "count to three");
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => expect((prompt as HTMLTextAreaElement).value).toBe("count to three"));
    screen.getByRole("button", { name: /Start run/ }).click();

    await waitFor(() => expect(posted.length).toBe(1));
    const body = posted[0] as { prompt: string; contestants: unknown[] };
    expect(body.prompt).toBe("count to three");
    expect(body.contestants).toEqual([
      { source: "opencode", model: null, stance: "for" },
      { source: "claude", model: null, stance: "for" },
    ]);
    await screen.findByRole("tablist", { name: "Compare by" });
  });

  test("the lineup grows, changes harness and shrinks one lane at a time", async () => {
    mount(harness().transport);
    screen.getByLabelText("Add a contestant").click();
    const third = await screen.findByRole("radiogroup", { name: "Contestant 3 harness" });
    expect(third.querySelector("[aria-checked=true]")?.textContent).toBe("Claude");
    (third.querySelector("[role=radio]") as HTMLButtonElement).click();
    await waitFor(() => expect(screen.getByText("Bake-off · 2 OpenCode vs 1 Claude")).toBeTruthy());

    screen.getByLabelText("Add a contestant").click();
    await screen.findByRole("radiogroup", { name: "Contestant 4 harness" });
    expect(screen.queryByLabelText("Add a contestant")).toBeNull();

    screen.getByLabelText("Remove contestant 1").click();
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "Contestant 4 harness" })).toBeNull());
  });

  test("For and against makes two lanes on the first lane's harness, one doing it, one arguing against it", async () => {
    const { transport, posted } = harness();
    mount(transport);
    screen.getByRole("button", { name: "For and against" }).click();
    await waitFor(() => expect(screen.getByText("For and against · 1 OpenCode vs 1 OpenCode against")).toBeTruthy());
    const second = screen.getByRole("radiogroup", { name: "Contestant 2 stance" });
    expect(second.querySelector("[aria-checked=true]")?.textContent).toBe("Against");

    // A lane's stance is its own switch too: the second lane turned back makes a variance run.
    within(second).getByRole("radio", { name: "For" }).click();
    await waitFor(() => expect(screen.getByText("Variance · 2 × OpenCode")).toBeTruthy());
    within(second).getByRole("radio", { name: "Against" }).click();
    await waitFor(() => expect(screen.getByText("For and against · 1 OpenCode vs 1 OpenCode against")).toBeTruthy());
    screen.getByRole("button", { name: /Open lanes/ }).click();
    await waitFor(() => expect(posted.length).toBe(1));
    expect((posted[0] as { contestants: unknown[] }).contestants).toEqual([
      { source: "opencode", model: null, stance: "for" },
      { source: "opencode", model: null, stance: "against" },
    ]);
  });

  test("a blank form opens lanes: the next name, a repository of the run's own, no prompt yet", async () => {
    const { transport, posted } = harness({ modes: ["terminals", "headless"] });
    mount(transport);
    await waitFor(() => expect(screen.getByLabelText("Run name").getAttribute("placeholder")).toBe("arena run 3"));
    const fresh = await screen.findByRole("radio", { name: /New repository.*\/Users\/me\/\.arena/ });
    expect((fresh as HTMLInputElement).checked).toBe(true);
    const open = await screen.findByRole("button", { name: /Open lanes/ });
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    open.click();
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toMatchObject({ name: "", repoPath: "", prompt: "", mode: "terminals", manager: "claude" });
  });

  test("an existing repository is chosen from this machine's projects, searched for by name", async () => {
    const { transport, posted } = harness({
      modes: ["terminals", "headless"],
      projects: [{ projectPath: "/Users/me/projects/agent-desk" }, { projectPath: "/Users/me/projects/harbor" }],
    });
    mount(transport);
    await screen.findByRole("radio", { name: /harbor/ });
    const search = screen.getByRole("searchbox", { name: "Search projects" });
    fireEvent.change(search, { target: { value: "desk" } });
    expect(screen.queryByRole("radio", { name: /harbor/ })).toBeNull();
    screen.getByRole("radio", { name: /agent-desk/ }).click();
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>("radio", { name: /New repository/ }).checked).toBe(false),
    );
    (await screen.findByRole("button", { name: /Open lanes/ })).click();
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toMatchObject({ repoPath: "/Users/me/projects/agent-desk" });
  });

  test("a plain folder offers to be made a repository, and only that click makes it one to choose", async () => {
    const { transport, made, posted } = harness({
      modes: ["terminals", "headless"],
      projects: [{ projectPath: "/Users/me/notes" }, { projectPath: "/tmp/gone" }, { projectPath: "/Users/me/app" }],
      folders: {
        "/Users/me/notes": { repository: false, problem: null },
        "/tmp/gone": { repository: false, problem: "does not exist" },
      },
    });
    mount(transport);
    const make = await screen.findByRole("button", { name: "Make it a git repository: notes" });
    const notes = screen.getByRole<HTMLInputElement>("radio", { name: /notes/ });
    expect(notes.disabled).toBe(true);
    expect(notes.closest("label")!.textContent).toContain("Not a git repository");
    const gone = screen.getByRole<HTMLInputElement>("radio", { name: /gone/ });
    expect(gone.disabled).toBe(true);
    expect(gone.closest("label")!.textContent).toContain("Does not exist");
    expect(screen.queryByRole("button", { name: /gone/ })).toBeNull();
    // Nothing is made until the reader asks, and a run is not what asks.
    expect([made, posted]).toEqual([[], []]);

    make.click();
    await waitFor(() => expect(screen.getByRole<HTMLInputElement>("radio", { name: /notes/ }).disabled).toBe(false));
    expect(made).toEqual(["/Users/me/notes"]);
    expect(screen.queryByRole("button", { name: /Make it a git repository/ })).toBeNull();
  });

  test("each lane may name its model, and a run with a manager may open with no lanes for it to add", async () => {
    const { transport, posted } = harness({ modes: ["terminals", "headless"] });
    mount(transport);
    screen.getByRole("button", { name: "Contestant 2 model" }).click();
    const aliases = await screen.findByRole("dialog", { name: "Contestant 2's model" });
    within(aliases)
      .getByRole("option", { name: /^Sonnet/ })
      .click();
    await waitFor(() => expect(screen.getByText("Bake-off · 1 OpenCode vs 1 Claude sonnet")).toBeTruthy());

    // A full id the aliases do not hold is typed into the menu's filter and used as typed.
    screen.getByRole("button", { name: "Contestant 2 model" }).click();
    const typed = within(await screen.findByRole("dialog", { name: "Contestant 2's model" })).getByLabelText(
      "Filter models",
    );
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(typed, "claude-opus-5-5");
    typed.dispatchEvent(new Event("input", { bubbles: true }));
    (await screen.findByRole("option", { name: "Use claude-opus-5-5" })).click();
    await waitFor(() => expect(screen.getByText("Bake-off · 1 OpenCode vs 1 Claude claude-opus-5-5")).toBeTruthy());
    expect(screen.queryByRole("dialog", { name: "Contestant 2's model" })).toBeNull();

    screen.getByLabelText("Remove contestant 2").click();
    await waitFor(() => expect(screen.queryByLabelText("Contestant 2 model")).toBeNull());
    screen.getByLabelText("Remove contestant 1").click();
    await waitFor(() => expect(screen.getByText("The manager plans the lanes")).toBeTruthy());

    screen.getByRole("radio", { name: "None" }).click();
    await waitFor(() => expect(screen.getByText("Add a lane, or choose a manager to plan them")).toBeTruthy());
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /Open manager/ }).disabled).toBe(true);

    screen.getByRole("radio", { name: "Claude" }).click();
    const open = await screen.findByRole("button", { name: /Open manager/ });
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    open.click();
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toMatchObject({ contestants: [], manager: "claude", prompt: "" });
  });

  test("an opencode lane picks its model from the serve's list, and goes back to the default when its harness changes", async () => {
    const { transport, posted } = harness({ modes: ["terminals", "headless"] });
    mount(transport);
    screen.getByRole("button", { name: "Contestant 1 model" }).click();
    const menu = await screen.findByRole("dialog", { name: "Contestant 1's model" });
    (await within(menu).findByRole("option", { name: /Kimi K2/ })).click();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Contestant 1's model" })).toBeNull());
    expect(screen.getByRole("button", { name: "Contestant 1 model" }).textContent).toContain("opencode-go/kimi-k2");
    await waitFor(() => expect(screen.getByText("Bake-off · 1 OpenCode opencode-go/kimi-k2 vs 1 Claude")).toBeTruthy());

    const harnesses = screen.getByRole("radiogroup", { name: "Contestant 1 harness" });
    within(harnesses).getByRole("radio", { name: "Claude" }).click();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Contestant 1 model" }).textContent).toContain("Default model"),
    );
    within(harnesses).getByRole("radio", { name: "OpenCode" }).click();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Contestant 1 model" }).textContent).toContain("Default model"),
    );

    screen.getByRole("button", { name: "Contestant 1 model" }).click();
    (await screen.findByRole("option", { name: /Big Pickle/ })).click();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Contestant 1 model" }).textContent).toContain("opencode/big-pickle"),
    );
    screen.getByRole("button", { name: /Open lanes/ }).click();
    await waitFor(() => expect(posted.length).toBe(1));
    expect((posted[0] as { contestants: unknown[] }).contestants[0]).toEqual({
      source: "opencode",
      model: "opencode/big-pickle",
      stance: "for",
    });
  });

  test("the manager is Claude unless the reader picks otherwise, and a headless run has none", async () => {
    const { transport, posted } = harness({ modes: ["terminals", "headless"] });
    mount(transport);
    const managers = await screen.findByRole("radiogroup", { name: "The run's manager" });
    expect(managers.querySelector("[aria-checked=true]")?.textContent).toBe("Claude");
    screen.getByRole("radio", { name: "None" }).click();
    await waitFor(() => expect(managers.querySelector("[aria-checked=true]")?.textContent).toBe("None"));
    const open = await screen.findByRole("button", { name: /Open lanes/ });
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    open.click();
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toMatchObject({ manager: null });
  });

  test("a run's manager waits as a switch in the header, and opens into a window of its session", async () => {
    const managed = run({
      manager: {
        source: "claude",
        status: "open",
        folder: "/arena/run/manager",
        sessionId: "manager-session",
        tmuxSession: "manager-pane",
        error: null,
      },
    });
    mount(harness({ runs: [managed], detail: managed }).transport);
    await openRun("say one word");
    const button = await screen.findByRole("button", { name: "Manager" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Manager" })).toBeNull();
    button.click();
    const window = await screen.findByRole("region", { name: "Manager" });
    expect(window.textContent).toContain("Manager · Claude");
    screen.getByRole("button", { name: "Close the manager" }).click();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Manager" })).toBeNull());
  });
});
