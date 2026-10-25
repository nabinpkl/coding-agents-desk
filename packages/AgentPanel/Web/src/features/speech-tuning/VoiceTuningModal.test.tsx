import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpeechTuningState } from "@agentdesk/agent-feed-wire";
import { panelQueryClient } from "@/query/panelQuery";
import { VoiceTuningPanel } from "@/features/speech-tuning/VoiceTuningModal";

const STATE: SpeechTuningState = {
  tuning: {
    on: false,
    evenLevels: true,
    loudnessDb: 16,
    thresholdDb: -30,
    ratio: 4,
    releaseMs: 50,
    boomCutHz: 140,
    mudDb: -2.5,
    presenceDb: 4,
  },
  ranges: {
    loudnessDb: { min: 0, max: 24, step: 0.5 },
    thresholdDb: { min: -50, max: -10, step: 1 },
    ratio: { min: 1, max: 10, step: 0.5 },
    releaseMs: { min: 20, max: 400, step: 5 },
    boomCutHz: { min: 40, max: 300, step: 5 },
    mudDb: { min: -9, max: 0, step: 0.5 },
    presenceDb: { min: 0, max: 10, step: 0.5 },
  },
};

let posted: unknown[] = [];

beforeEach(() => {
  posted = [];
  panelQueryClient.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push({ url, body });
        if (url === "/api/speech/read") {
          return Response.json({ error: { code: "nobody_listening", message: "nobody" } }, { status: 409 });
        }
        return Response.json({ ...STATE, tuning: { ...STATE.tuning, ...body } });
      }
      return Response.json(STATE);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("draws each setting from the ranges the speech process reports, with its value", async () => {
  render(<VoiceTuningPanel onClose={() => {}} />);
  const loudness = await screen.findByLabelText("Loudness");
  expect(loudness).toHaveAttribute("max", "24");
  expect(loudness).toHaveValue("16");
  expect(screen.getByText("+16 dB")).toBeInTheDocument();
  expect(screen.getByText("4:1")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Process speech" })).not.toBeChecked();
});

it("sends a moved setting and a switch, and shows the new value at once", async () => {
  render(<VoiceTuningPanel onClose={() => {}} />);
  fireEvent.change(await screen.findByLabelText("Consonant lift at 3 kHz"), { target: { value: "7" } });
  fireEvent.click(screen.getByRole("switch", { name: "Process speech" }));
  expect(screen.getByText("+7 dB")).toBeInTheDocument();
  await waitFor(() => expect(posted).toEqual([{ url: "/api/speech/tuning", body: { presenceDb: 7, on: true } }]));
  expect(screen.getByRole("switch", { name: "Process speech" })).toBeChecked();
});

it("says so when nobody is listening to hear the sample", async () => {
  render(<VoiceTuningPanel onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Hear it" }));
  expect(await screen.findByText("Nobody is listening on Agent Radio.")).toBeInTheDocument();
});
