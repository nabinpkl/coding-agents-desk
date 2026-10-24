import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { BotView, ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { BotMachine } from "@/features/bots/botMachines";
import type { SessionViewContext } from "@/features/session-view/sessionTerminalTypes";
import { LiveSessionModal } from "@/features/session-view/modal/LiveSessionModal";

vi.mock("@/features/session-view/modal/SessionModal", () => ({
  SessionModal: ({ session }: { session: SessionSummary }) => <h2>{session.title}</h2>,
}));

const PROJECT: ProjectSummary = {
  projectPath: "/home/ubuntu/rags",
  displayName: "rags",
  sourceCounts: { claude: 1 },
  sessionCount: 1,
  lastEventAt: 1,
};
const OPENED = { source: "claude", sessionId: "s1", title: "Old name", lastEventAt: 1 } as SessionSummary;
const renamed = (title: string) => ({ ...OPENED, title });

/** A machine whose inventory stream the test speaks for. */
function machine() {
  let handlers: { onSessions: (path: string, sessions: SessionSummary[], archived: SessionSummary[]) => void } | null =
    null;
  const subscribeInventory = vi.fn((_paths: readonly string[], given: NonNullable<typeof handlers>) => {
    handlers = given;
    return () => {};
  });
  const value = { id: "oracle", label: "oracle", feed: { subscribeInventory } } as unknown as BotMachine;
  return {
    machine: value,
    subscribeInventory,
    list: (sessions: SessionSummary[]) => act(() => handlers!.onSessions(PROJECT.projectPath, sessions, [])),
  };
}

function modal(
  on: BotMachine,
  { bots = [], lists = new Map() }: { bots?: BotView[]; lists?: Map<string, SessionSummary[]> } = {},
) {
  return render(
    <LiveSessionModal
      bots={bots}
      sessionsByProject={lists}
      machine={on}
      context={{} as SessionViewContext}
      project={PROJECT}
      session={OPENED}
      onClose={vi.fn()}
    />,
  );
}

it("shows a Bot's live record of the session and reads nothing", () => {
  const { machine: on, subscribeInventory } = machine();
  const bot = { botId: "b", sessions: [renamed("Renamed on the Bot")] } as unknown as BotView;
  modal(on, { bots: [bot] });
  expect(screen.getByRole("heading")).toHaveTextContent("Renamed on the Bot");
  expect(subscribeInventory).not.toHaveBeenCalled();
});

it("shows the row of a directory list the panel already follows, and reads nothing", () => {
  const { machine: on, subscribeInventory } = machine();
  modal(on, { lists: new Map([[PROJECT.projectPath, [renamed("Renamed in the list")]]]) });
  expect(screen.getByRole("heading")).toHaveTextContent("Renamed in the list");
  expect(subscribeInventory).not.toHaveBeenCalled();
});

it("reads its directory on its own machine when nothing lists it, and follows a rename there", () => {
  const { machine: on, subscribeInventory, list } = machine();
  // Another machine's `/home/ubuntu/rags` is no answer: it does not list this session.
  modal(on, { lists: new Map([[PROJECT.projectPath, [{ ...OPENED, sessionId: "elsewhere" }]]]) });
  expect(subscribeInventory).toHaveBeenCalledWith([PROJECT.projectPath], expect.anything(), expect.anything());
  // The row it opened with until the directory answers.
  expect(screen.getByRole("heading")).toHaveTextContent("Old name");
  list([OPENED]);
  expect(screen.getByRole("heading")).toHaveTextContent("Old name");
  list([renamed("Named by /rename")]);
  expect(screen.getByRole("heading")).toHaveTextContent("Named by /rename");
});

it("keeps the name it was handed while the live row has none of its own yet", () => {
  const { machine: on } = machine();
  // A row with no name is titled with the session's id.
  modal(on, { lists: new Map([[PROJECT.projectPath, [renamed(OPENED.sessionId)]]]) });
  expect(screen.getByRole("heading")).toHaveTextContent("Old name");
});
