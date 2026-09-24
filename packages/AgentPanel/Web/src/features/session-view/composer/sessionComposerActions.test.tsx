/**
 * The in-field button is one button with two jobs: Send while idle, Stop while running.
 *
 * No separate stop beside it, because two buttons for one slot is how a reader presses Stop
 * and watches Send stay where it was. The key and placement never change across the swap,
 * which is what makes it the same button rather than a replacement.
 */

import { describe, expect, it } from "vitest";
import { composerActions } from "@/features/session-view/composer/sessionComposerActions";
import type { ComposerModel } from "@/features/session-view/composer/sessionComposerModel";

function model(overrides: Partial<ComposerModel> = {}): ComposerModel {
  return {
    capabilities: {
      modes: ["nice"],
      canSend: true,
      canSteer: true,
      canAbort: true,
      canFetchRaw: false,
      canOpenTerminal: false,
      supportsExtensionUi: false,
      canStreamLive: false,
    },
    deliveryPending: false,
    editorValue: "hello",
    pending: false,
    running: false,
    ...overrides,
  } as ComposerModel;
}

describe("the in-field send button", () => {
  it("sends while idle", () => {
    const actions = composerActions(model({ running: false }));
    const send = actions.find((action) => action.key === "send");
    expect(send?.ariaLabel).toBe("Send message");
    expect(send?.placement).toBe("field");
    expect(actions.some((action) => action.key === "abort")).toBe(false);
  });

  it("is the same button, stopping, while running", () => {
    const actions = composerActions(model({ running: true }));
    const stop = actions.find((action) => action.key === "send");
    expect(stop?.ariaLabel).toBe("Stop agent");
    expect(stop?.placement).toBe("field");
    expect(stop?.disabled).toBe(false);
    expect(actions.some((action) => action.key === "abort")).toBe(false);
  });

  it("stays a queueing send while running where nothing can abort", () => {
    const actions = composerActions(model({
      running: true,
      capabilities: {
        modes: ["nice"],
        canSend: true,
        canSteer: false,
        canAbort: false,
        canFetchRaw: false,
        canOpenTerminal: false,
        supportsExtensionUi: false,
        canStreamLive: false,
      },
    }));
    expect(actions.find((action) => action.key === "send")?.ariaLabel).toBe("Queue message");
  });
});
