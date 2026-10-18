// The context windows this machine's opencode models have, fetched once and shared.
//
// Every opencode session asks for its model's denominator, and every ask before the first
// answer would otherwise repeat the same list request. One in-flight promise and one map make
// the second caller wait for the first rather than start a second fetch; a failed lookup clears
// the latch so a later session can try again, and a missing limit stays missing rather than
// becoming a guessed bar on the meter.

import { fetchOpencodeModelLimits } from "@/agents/opencode/serve/opencodeServeCalls";

export class OpencodeModelLimits {
  private readonly limits = new Map<string, number>();
  private loading: Promise<void> | null = null;

  async limit(modelKey: string): Promise<number | null> {
    const known = this.limits.get(modelKey);
    if (known !== undefined) return known;
    if (!this.loading) {
      this.loading = fetchOpencodeModelLimits().then(
        (limits) => {
          for (const [key, limit] of limits) this.limits.set(key, limit);
        },
        () => {},
      ).finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
    return this.limits.get(modelKey) ?? null;
  }
}
