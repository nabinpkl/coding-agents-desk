import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpeechTuning, SpeechTuningState } from "@agentdesk/agent-feed-wire";
import { createTuningSender } from "@/features/speech-tuning/speechTuning";

const STATE = { tuning: { on: true }, ranges: {} } as unknown as SpeechTuningState;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("gathers a drag into one change carrying the newest value", async () => {
  const send = vi.fn(async (_changes: Partial<SpeechTuning>) => STATE);
  const sender = createTuningSender({ send, onAnswer: vi.fn(), onFailure: vi.fn(), gatherMs: 100 });
  sender.change("loudnessDb", 10);
  sender.change("loudnessDb", 12);
  sender.change("ratio", 3);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(send).toHaveBeenCalledExactlyOnceWith({ loudnessDb: 12, ratio: 3 });
});

it("holds what moves while a request is out, and sends it once that one is answered", async () => {
  let answer: (state: SpeechTuningState) => void = () => {};
  const send = vi.fn(
    (_changes: Partial<SpeechTuning>) =>
      new Promise<SpeechTuningState>((resolve) => {
        answer = resolve;
      }),
  );
  const onAnswer = vi.fn();
  const sender = createTuningSender({ send, onAnswer, onFailure: vi.fn(), gatherMs: 100 });
  sender.change("loudnessDb", 10);
  await vi.advanceTimersByTimeAsync(100);
  sender.change("loudnessDb", 14);
  await vi.advanceTimersByTimeAsync(100);
  expect(send).toHaveBeenCalledTimes(1);
  answer(STATE);
  await vi.advanceTimersByTimeAsync(0);
  expect(onAnswer).toHaveBeenCalledOnce();
  expect(send).toHaveBeenLastCalledWith({ loudnessDb: 14 });
});

it("hands back what was not sent when the speech process refuses it", async () => {
  const send = vi.fn(async (_changes: Partial<SpeechTuning>): Promise<SpeechTuningState> => {
    throw new Error("the speech process did not answer");
  });
  const onFailure = vi.fn();
  const sender = createTuningSender({ send, onAnswer: vi.fn(), onFailure, gatherMs: 100 });
  sender.change("presenceDb", 6);
  await vi.advanceTimersByTimeAsync(100);
  expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "the speech process did not answer" }), {
    presenceDb: 6,
  });
});
