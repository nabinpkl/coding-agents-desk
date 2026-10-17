// A stand-in for the Agent SDK, for tests that drive a runner without a CLI.

import type { CanUseTool, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunnerQuery } from "@/claude-sdk/claudeSdkRunner";

/** A stand-in for the SDK: the test pushes the messages `claude` would send and reads its input. */
export class FakeQuery implements RunnerQuery {
  readonly modes: string[] = [];
  interrupts = 0;
  readonly received: SDKUserMessage[] = [];
  private readonly outbox: SDKMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  constructor(readonly options: Options, prompt: AsyncIterable<SDKUserMessage>) {
    void (async () => {
      for await (const message of prompt) this.received.push(message);
      this.end();
    })();
  }

  get canUseTool(): CanUseTool {
    return this.options.canUseTool!;
  }

  send(message: Record<string, unknown>): void {
    this.outbox.push(message as unknown as SDKMessage);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.modes.push(mode);
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  readonly models: string[] = [];

  async setModel(model?: string): Promise<void> {
    this.models.push(model ?? "default");
  }

  async supportedModels() {
    return [
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Most capable" },
      { value: "haiku", resolvedModel: "claude-haiku-4-5", displayName: "Haiku", description: "Fastest" },
    ];
  }

  readonly renamed: string[] = [];

  async renameSession(title: string, sessionId?: string): Promise<void> {
    this.renamed.push(`${title} ${sessionId}`);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      const next = this.outbox.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}
