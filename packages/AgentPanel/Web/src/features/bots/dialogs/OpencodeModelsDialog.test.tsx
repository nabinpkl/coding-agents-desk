import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { OpencodeModelsDialog, OpencodeModelsHost } from "@/features/bots/dialogs/OpencodeModelsDialog";
import type { OpencodeModel } from "@/features/activity-feed/data-source/SidecarAgentSessions";

const MODELS: OpencodeModel[] = [
  { providerID: "opencode-go", modelID: "spark", name: "Muse Spark", contextLimit: 1048576, inputCost: 0.1, outputCost: 0.2 },
  { providerID: "other", modelID: "tiny", name: "Tiny", contextLimit: null, inputCost: null, outputCost: null },
];

describe("OpencodeModelsDialog", () => {
  it("marks the current model and shows context and cost", () => {
    render(
      <OpencodeModelsDialog
        models={MODELS}
        current="opencode-go/spark"
        initialFilter=""
        onClose={() => {}}
        onSwitch={async () => {}}
      />,
    );

    expect(screen.getByRole("option", { name: /Muse Spark.*current/ })).toBeTruthy();
    expect(screen.getByText(/1M context/)).toBeTruthy();
    expect(screen.getByText(/\$0\.1\/\$0\.2 per MTok/)).toBeTruthy();
  });

  it("filters by the slash args it opened with", () => {
    render(
      <OpencodeModelsDialog
        models={MODELS}
        current={null}
        initialFilter="tiny"
        onClose={() => {}}
        onSwitch={async () => {}}
      />,
    );

    expect(screen.queryByRole("option", { name: /Muse Spark/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Tiny/ })).toBeTruthy();
  });

  it("switches on choose and reports a refusal without closing", async () => {
    const onSwitch = vi.fn(async (_model: OpencodeModel) => {});
    const onClose = vi.fn();
    render(
      <OpencodeModelsDialog
        models={MODELS}
        current={null}
        initialFilter=""
        onClose={onClose}
        onSwitch={onSwitch}
      />,
    );

    fireEvent.click(screen.getByRole("option", { name: /Tiny/ }));
    expect(onSwitch).toHaveBeenCalledWith(MODELS[1]);
  });

  it("is an anchored menu, not a modal, and closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <OpencodeModelsDialog
        models={MODELS}
        current={null}
        initialFilter=""
        onClose={onClose}
        onSwitch={async () => {}}
      />,
    );

    const menu = screen.getByRole("dialog", { name: "Switch model" });
    expect(document.querySelector("dialog")).toBeNull();
    expect(menu.className).toMatch(/absolute/);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("renders nothing while the list loads, and closes a failed load", async () => {
    const onClose = vi.fn();
    const feed = { listOpencodeModels: async () => MODELS } as never;
    const { rerender } = render(
      <OpencodeModelsHost
        feed={feed}
        usage={null}
        initialFilter=""
        onClose={onClose}
        onSwitch={async () => {}}
      />,
    );
    expect(screen.queryByRole("dialog", { name: "Switch model" })).toBeNull();
    rerender(
      <OpencodeModelsHost
        feed={feed}
        usage={{ current: 1, limit: null, updatedAt: 0, model: "other/tiny" } as never}
        initialFilter=""
        onClose={onClose}
        onSwitch={async () => {}}
      />,
    );
    expect(await screen.findByRole("dialog", { name: "Switch model" })).toBeTruthy();
  });
});
