// What is worth pinning is that a face is a NAME: it must not move, and two Bots must not share it.
//
// The drawing itself is a taste question and belongs in a browser. What belongs here is the
// arithmetic under it, because both of its failures are silent -- a face that changes when the
// roster grows teaches a reader a name and then takes it away, and two Bots with one face teach
// them nothing at all.

import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { BOT_FACE_CYCLE, BotFace, botFaceOf } from "@/features/bots/avatar/BotFace";

const key = (rank: number): string => {
  const face = botFaceOf(rank);
  return `${face.head}|${face.top.join("+")}|${face.eyes.map((e) => `${e.cx}:${e.rx}:${e.ry}`).join(",")}`;
};

describe("botFaceOf", () => {
  test("a whole cycle of Bots has a whole cycle of faces", () => {
    const seen = new Set<string>();
    for (let rank = 0; rank < BOT_FACE_CYCLE; rank += 1) seen.add(key(rank));
    expect(seen.size).toBe(BOT_FACE_CYCLE);
  });

  test("neighbours differ in every part, not only in one", () => {
    for (let rank = 0; rank < BOT_FACE_CYCLE; rank += 1) {
      const here = botFaceOf(rank);
      const next = botFaceOf(rank + 1);
      expect(here.head).not.toBe(next.head);
      expect(here.top).not.toBe(next.top);
      expect(here.eyes).not.toBe(next.eyes);
    }
  });

  test("a face is the same face on every call", () => {
    expect(botFaceOf(6)).toEqual(botFaceOf(6));
  });

  test("the cycle is where it says it is", () => {
    expect(key(BOT_FACE_CYCLE)).toBe(key(0));
    expect(key(BOT_FACE_CYCLE + 5)).toBe(key(5));
  });

  test("a rank no roster can produce still draws a face", () => {
    expect(botFaceOf(-3).head).toBe(botFaceOf(3).head);
    expect(botFaceOf(2.7).head).toBe(botFaceOf(2).head);
  });
});

describe("BotFace", () => {
  test("open eyes blink and shut eyes do not", () => {
    const { container, rerender } = render(<BotFace rank={2} />);
    const eyes = container.querySelector<SVGGElement>(".bot-face-eyes")!;
    expect(eyes.className.baseVal).toContain("bot-face-eyes--open");
    rerender(<BotFace rank={2} shut />);
    expect(container.querySelector<SVGGElement>(".bot-face-eyes")!.className.baseVal)
      .toContain("bot-face-eyes--shut");
  });

  test("two Bots on one screen do not blink together", () => {
    const { container } = render(
      <>
        <BotFace rank={1} />
        <BotFace rank={2} />
      </>,
    );
    const [first, second] = [...container.querySelectorAll<SVGGElement>(".bot-face-eyes")];
    expect(first!.style.getPropertyValue("--bot-face-blink-delay"))
      .not.toBe(second!.style.getPropertyValue("--bot-face-blink-delay"));
  });

  test("the face says nothing to a screen reader, because the row already does", () => {
    render(<BotFace rank={0} />);
    expect(screen.queryByRole("img")).toBeNull();
  });
});
