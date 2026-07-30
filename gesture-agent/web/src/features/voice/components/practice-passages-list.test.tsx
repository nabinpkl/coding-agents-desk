/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PracticePassagesList } from "@/features/voice/components/practice-passages-list";
import { ApiError } from "@/lib/api";
import type { PracticePassage, Recording } from "@/lib/wire";

const api = vi.hoisted(() => ({
  listPassages: vi.fn(),
  listAttempts: vi.fn(),
  updateText: vi.fn(),
  updateBaseline: vi.fn(),
  deleteAttempt: vi.fn(),
  deletePassage: vi.fn(),
  reanalyze: vi.fn(),
}));
const idlePlayback = vi.hoisted(
  () => ({ status: "idle" as const }),
);

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    listPracticePassages: api.listPassages,
    listPracticePassageAttempts: api.listAttempts,
    updatePracticePassageText: api.updateText,
    updatePracticePassageBaseline: api.updateBaseline,
    deletePracticePassageAttempt: api.deleteAttempt,
    deletePracticePassage: api.deletePassage,
    reanalyzeRecording: api.reanalyze,
  };
});

vi.mock("@/features/voice/reference-speech-settings", () => ({
  useReferenceSpeechSettings: () => ({
    view: {
      status: "ready",
      preferences: { voiceIdentifier: "af_heart", speed: 1 },
      voices: [],
      speed: { minimum: 0.5, defaultValue: 1, maximum: 2 },
    },
    update: vi.fn(),
  }),
}));

vi.mock(
  "@/features/voice/components/reference-speech-controls",
  () => ({
    ReferenceSpeechControls: () => (
      <section aria-label="Reference speech">Reference speech</section>
    ),
  }),
);

vi.mock("@/features/voice/reference-speech", () => ({
  referenceSpeechPlaybackSnapshot: () => idlePlayback,
  speakReference: vi.fn().mockResolvedValue(undefined),
  stopReferenceSpeech: vi.fn(),
  subscribeReferenceSpeechPlayback: () => () => undefined,
}));

vi.mock("@/stores/voice-store", () => ({
  useVoiceStore: (
    selector: (state: { runState: { status: "idle" } }) => unknown,
  ) => selector({ runState: { status: "idle" } }),
}));

vi.mock("@/lib/host-bridge", () => ({
  getHostConfig: () => undefined,
}));

const passage: PracticePassage = {
  id: `passage-${"1".repeat(32)}`,
  intendedText: "Hello. How are you?",
  revision: 3,
  createdAt: "2026-07-30T00:00:00Z",
  updatedAt: "2026-07-30T00:02:00Z",
  baselineRecordingID: "session-20260730-000000-000001",
  attemptCount: 2,
  latestAttemptCreatedAt: "2026-07-30T00:01:00Z",
};

function attempt(
  id: string,
  machineTranscript: string,
  heard: string,
): Recording {
  return {
    id,
    passageId: passage.id,
    passageRevision: passage.revision,
    createdAt:
      id === "session-20260730-000100-000002"
        ? "2026-07-30T00:01:00Z"
        : "2026-07-30T00:00:00Z",
    durationSeconds: 1.5,
    source: "macos",
    status: "completed",
    machineTranscript,
    intendedText: passage.intendedText,
    observedPhones: heard.split(" "),
    wordPhoneGroups: [
      {
        word: "hello",
        heardPhones: ["h", "ə", "l", "oʊ"],
        referencePhones: ["h", "ə", "l", "oʊ"],
        hasReferencePronunciation: true,
      },
      {
        word: "are",
        heardPhones: heard.split(" "),
        referencePhones: ["ɑɹ"],
        hasReferencePronunciation: true,
      },
    ],
    unknownReferenceWords: ["are"],
    sampleRate: 16_000,
  };
}

const baseline = attempt(
  "session-20260730-000000-000001",
  "Hello. How would you?",
  "w ʊ d",
);
const selected = attempt(
  "session-20260730-000100-000002",
  "Hello. How are you?",
  "ɑ ɹ",
);

function renderList(
  onRetake = vi.fn(),
  completedPassageID: string | undefined = passage.id,
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return {
    onRetake,
    ...render(
      <QueryClientProvider client={client}>
        <PracticePassagesList
          completedPassageID={completedPassageID}
          onRetake={onRetake}
        />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
  api.listPassages.mockResolvedValue({
    passages: [passage],
    nextCursor: null,
  });
  api.listAttempts.mockResolvedValue({
    passage,
    attempts: [selected, baseline],
    nextCursor: null,
  });
  api.updateText.mockResolvedValue({
    ...passage,
    intendedText: "Hello there",
    revision: passage.revision + 1,
  });
  api.updateBaseline.mockResolvedValue(passage);
  api.deleteAttempt.mockResolvedValue(undefined);
  api.deletePassage.mockResolvedValue(undefined);
  api.reanalyze.mockResolvedValue(selected);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("PracticePassagesList", () => {
  it("renders loading, empty, and error states explicitly", async () => {
    api.listPassages.mockReturnValueOnce(new Promise(() => undefined));
    const loading = renderList(vi.fn(), undefined);
    expect(screen.getByText("Loading passages")).toBeTruthy();
    loading.unmount();

    api.listPassages.mockResolvedValueOnce({
      passages: [],
      nextCursor: null,
    });
    const empty = renderList(vi.fn(), undefined);
    expect(
      await screen.findByText("No passages yet. Record a new passage to begin."),
    ).toBeTruthy();
    empty.unmount();

    api.listPassages.mockRejectedValueOnce(new Error("library unavailable"));
    renderList(vi.fn(), undefined);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "library unavailable",
    );
  });

  it("keeps intended text editable while machine evidence stays visible", async () => {
    const onRetake = vi.fn();
    renderList(onRetake);

    expect(await screen.findByText("Hello. How would you?")).toBeTruthy();
    expect(
      screen.getByLabelText(
        "Word differences between machine heard and intended text",
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("No dictionary entry: are")).toHaveLength(2);

    fireEvent.click(
      screen.getByRole("button", { name: "Record another take" }),
    );
    expect(onRetake).toHaveBeenCalledWith(passage);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Intended text" });
    fireEvent.change(editor, { target: { value: "Discard this edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.updateText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Intended text" }),
      { target: { value: "Hello there" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateText).toHaveBeenCalledWith(passage.id, {
        intendedText: "Hello there",
        expectedRevision: passage.revision,
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "Intended text updated.",
    );
  });

  it("presents revision conflicts as recoverable errors", async () => {
    api.updateText.mockRejectedValueOnce(
      new ApiError(409, "Conflict", "stale revision"),
    );
    renderList();
    await screen.findByText("Hello. How would you?");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Intended text" }),
      { target: { value: "Stale edit" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Intended text changed on another surface",
    );
    expect(
      (screen.getByRole("textbox", {
        name: "Intended text",
      }) as HTMLTextAreaElement).value,
    ).toBe("Stale edit");
  });

  it("shows labeled, no-score A/B transcript and phone evidence", async () => {
    api.listAttempts.mockImplementation(
      (
        _passageID: string,
        options: { readonly cursor?: string },
      ) =>
        Promise.resolve(
          options.cursor
            ? {
                passage,
                attempts: [baseline],
                nextCursor: null,
              }
            : {
                passage,
                attempts: [selected],
                nextCursor: selected.id,
              },
        ),
    );
    renderList();
    fireEvent.click(
      await screen.findByRole("button", { name: "Show earlier attempts" }),
    );
    await waitFor(() => expect(api.listAttempts).toHaveBeenCalledTimes(2));

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "Compare as B",
        hidden: true,
      })[0],
    );

    const comparison = screen.getByRole("region", {
      name: "A/B attempt comparison",
    });
    expect(within(comparison).getByText(/No score or improvement/)).toBeTruthy();
    expect(
      within(comparison).getByLabelText(
        "Word differences between machine transcripts A and B",
      ).textContent,
    ).toContain("A: would");
    expect(within(comparison).getAllByText("A heard")).toHaveLength(2);
    expect(within(comparison).getAllByText("B heard")).toHaveLength(2);
    expect(within(comparison).getAllByText("Reference")).toHaveLength(2);
  });
});
