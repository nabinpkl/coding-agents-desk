// What every delete's question has to get right: Cancel comes first, nothing closes it while the
// delete runs, and a failure stays in it.

import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ConfirmDeleteDialog } from "@/features/confirm-delete/ConfirmDeleteDialog";

function question(over: Partial<Parameters<typeof ConfirmDeleteDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDeleteDialog
      open
      title="Delete arena run 3?"
      confirmLabel="Delete run"
      busy={false}
      error={null}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    >
      Its lanes go.
    </ConfirmDeleteDialog>,
  );
  return { onConfirm, onCancel };
}

it("names the thing, puts Cancel first, and deletes only from its own button", () => {
  const { onConfirm, onCancel } = question();
  const dialog = screen.getByRole("dialog", { name: "Delete arena run 3?" });
  expect(dialog.textContent).toContain("Its lanes go.");
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Delete run"]);
  fireEvent.click(screen.getByRole("button", { name: "Delete run" }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onCancel).not.toHaveBeenCalled();
});

it("cancels on Escape and on the backdrop", () => {
  const { onCancel } = question();
  const dialog = screen.getByRole("dialog");
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  fireEvent.click(dialog);
  expect(onCancel).toHaveBeenCalledTimes(2);
});

it("cannot be left or pressed again while the delete runs, and shows a failure in place", () => {
  const { onCancel } = question({ busy: true, error: "run is adding lanes" });
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  fireEvent.click(screen.getByRole("dialog"));
  expect(onCancel).not.toHaveBeenCalled();
  expect(screen.getAllByRole<HTMLButtonElement>("button").every((button) => button.disabled)).toBe(true);
  expect(screen.getByRole("alert").textContent).toBe("run is adding lanes");
});

it("draws nothing while closed", () => {
  question({ open: false });
  expect(screen.queryByRole("dialog")).toBeNull();
});
