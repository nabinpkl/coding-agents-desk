import { describe, expect, it } from "bun:test";
import { readOpencodeTail } from "@/agents/opencode/opencodeHistory";

const message = (id: string) => ({ id, type: "assistant" });

describe("readOpencodeTail", () => {
  it("asks newest-first and returns the page chronological", async () => {
    const seen: string[] = [];
    // The wire answers newest-first; the anchor and mapper both take oldest-first, so the
    // tail reverses before returning. A bare limit once answered newest-first straight
    // through, and the meter reported the page's oldest turn as the live window.
    const tail = await readOpencodeTail("ses_probe", async (path) => {
      seen.push(path);
      return {
        status: 200,
        text: JSON.stringify({ data: [message("c"), message("b"), message("a")] }),
      };
    });
    expect(seen).toEqual(["/api/session/ses_probe/message?order=desc&limit=200"]);
    expect(tail.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});
