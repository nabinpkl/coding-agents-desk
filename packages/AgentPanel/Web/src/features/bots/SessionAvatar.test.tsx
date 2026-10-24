// A session's mark follows the same switch as its Bot's avatar, on the Bot's face.

import { beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SessionAvatar } from "@/features/bots/SessionAvatar";
import { setBotFaces } from "@/features/bots/avatar/botFacesSwitch";

describe("SessionAvatar faces switch", () => {
  beforeEach(() => {
    localStorage.clear();
    setBotFaces(false);
  });

  it("wears its title's initials until faces are chosen", () => {
    const { container } = render(<SessionAvatar title="First session" activity="cold" shaded rank={0} />);
    expect(container.textContent).toContain("FS");
    expect(container.querySelector(".bot-face")).toBeNull();
  });

  it("wears its Bot's face once faces are chosen", () => {
    setBotFaces(true);
    const { container } = render(<SessionAvatar title="First session" activity="cold" shaded rank={0} />);
    expect(container.querySelector(".bot-face")).not.toBeNull();
    expect(container.textContent).not.toContain("FS");
  });

  it("keeps the live ring on the face, because the face cannot say live", () => {
    setBotFaces(true);
    const { container } = render(<SessionAvatar title="First session" activity="live" shaded rank={0} />);
    const face = container.querySelector<SVGGElement>(".bot-face")!;
    expect(face.getAttribute("class")).toContain("ring-green-500");
  });

  it("an unshaded session keeps its disc whatever the switch says", () => {
    // No hue in scope means no colour for a head to take: the honest answer is the neutral disc,
    // the same fallback the Bot's own avatar takes without a rank.
    setBotFaces(true);
    const { container } = render(<SessionAvatar title="First session" activity="cold" shaded={false} rank={0} />);
    expect(container.textContent).toContain("FS");
    expect(container.querySelector(".bot-face")).toBeNull();
  });

  it("a session with no rank keeps its initials when faces are on", () => {
    setBotFaces(true);
    const { container } = render(<SessionAvatar title="First session" activity="cold" shaded />);
    expect(container.textContent).toContain("FS");
    expect(container.querySelector(".bot-face")).toBeNull();
  });
});

describe("SessionAvatar fold", () => {
  beforeEach(() => {
    localStorage.clear();
    setBotFaces(true);
  });

  it("shuts the face's eyes when its card is folded", () => {
    const { container } = render(<SessionAvatar title="First session" activity="cold" shaded rank={0} shut />);
    expect(container.querySelector(".bot-face-eyes--shut")).not.toBeNull();
  });

  it("leaves them open when it is not", () => {
    const { container } = render(<SessionAvatar title="First session" activity="cold" shaded rank={0} />);
    expect(container.querySelector(".bot-face-eyes--open")).not.toBeNull();
  });

  // Every face says cold the same way, so a session reads alike on its card and in every list.
  it("draws a cold session's sleeping Zs wherever its face is drawn, and only while it is cold", () => {
    const cold = render(<SessionAvatar title="First session" activity="cold" shaded rank={0} />);
    expect(cold.container.querySelector("svg[data-sleeping]")).not.toBeNull();
    const initials = render(<SessionAvatar title="First session" activity="cold" shaded={false} />);
    expect(initials.container.querySelector("svg[data-sleeping]")).not.toBeNull();
    const live = render(<SessionAvatar title="First session" activity="live" shaded rank={0} className="mt-0.5" />);
    expect(live.container.querySelector("svg[data-sleeping]")).toBeNull();
    // Its classes still land on the mark when there are no Zs to wrap it in.
    expect(live.container.firstElementChild?.getAttribute("class")).toContain("mt-0.5");
    const paused = render(<SessionAvatar title="First session" activity="paused" shaded rank={0} />);
    expect(paused.container.querySelector("svg[data-sleeping]")).toBeNull();
  });
});
