import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BotAvatar } from "@/features/bots/avatar/BotAvatar";
import { setBotFaces } from "@/features/bots/avatar/BotFace";

afterEach(cleanup);

/**
 * The faces switch: initials until chosen, faces everywhere a rank reaches after.
 *
 * The toggle in the roster's header is the switch's one control; what is pinned here is what it
 * changes, which is every avatar the switch reaches rather than the one surface it is pressed on. An unranked Bot keeps its initials whatever the switch says, because
 * the creator's preview is of a Bot that does not exist and ranking it would promise a face the
 * roster may not give it.
 */
describe("BotAvatar faces switch", () => {
  beforeEach(() => {
    localStorage.clear();
    setBotFaces(false);
  });

  it("a ranked Bot wears its initials until faces are chosen", () => {
    const { container, rerender } = render(<BotAvatar bot={{ name: "Alpha Bot" }} hue={24} rank={0} />);
    expect(container.textContent).toContain("AB");
    expect(container.querySelector(".bot-face")).toBeNull();

    setBotFaces(true);
    rerender(<BotAvatar bot={{ name: "Alpha Bot" }} hue={24} rank={0} />);
    expect(container.querySelector(".bot-face")).not.toBeNull();
    expect(container.textContent).not.toContain("AB");
  });

  it("a Bot with no rank keeps its initials when faces are on", () => {
    setBotFaces(true);
    const { container } = render(<BotAvatar bot={{ name: "New Bot" }} />);
    expect(container.textContent).toContain("NB");
    expect(container.querySelector(".bot-face")).toBeNull();
  });

  it("a press reaches avatars mounted after it", () => {
    const { container, unmount } = render(<BotAvatar bot={{ name: "Alpha Bot" }} hue={24} rank={0} />);
    expect(container.querySelector(".bot-face")).toBeNull();
    setBotFaces(true);
    unmount();
    const { container: next } = render(<BotAvatar bot={{ name: "Alpha Bot" }} hue={24} rank={0} />);
    expect(next.querySelector(".bot-face")).not.toBeNull();
  });
});
