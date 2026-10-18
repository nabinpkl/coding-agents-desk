import { describe, expect, test } from "bun:test";
import {
  ControlHelperError,
  createControlHelper,
  type HelperProcess,
} from "@/desktop/controlHelper";
import type { HelperBinary } from "@/desktop/helperBinary";

const KIND_META = 0;
const KIND_CONTROL = 4;

/** A helper whose frames this test writes by hand. No child process, no binary. */
function fakeProcess() {
  const queue: { kind: number; payload: Uint8Array }[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  const written: string[] = [];
  let killed = false;

  async function* stream(): AsyncGenerator<{ kind: number; payload: Uint8Array }> {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (ended) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }

  return {
    written,
    get killed() {
      return killed;
    },
    emit(kind: number, message: unknown) {
      queue.push({ kind, payload: new TextEncoder().encode(JSON.stringify(message)) });
      notify?.();
      notify = null;
    },
    end() {
      ended = true;
      notify?.();
      notify = null;
    },
    process: {
      write: (line: string) => {
        written.push(line);
        return Promise.resolve();
      },
      frames: stream(),
      kill: () => {
        killed = true;
        ended = true;
        notify?.();
        notify = null;
      },
    } satisfies HelperProcess,
  };
}

function binary(mtimeMs: number): HelperBinary {
  return { path: "/fake/grid-encoder", mtimeMs, exists: true };
}

/**
 * Swallows the rejection of a request this test never intends to answer. `stop()` fails everything
 * in flight, which is the behaviour under test elsewhere; here it would surface as an unhandled
 * rejection about a promise the test deliberately abandoned.
 */
function ignore(pending: Promise<unknown>): void {
  void pending.catch(() => {});
}

/** Lets the frame reader drain what was just emitted. It is a real async generator, not a callback. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The rid the helper client assigned to the Nth request it wrote. */
function ridOf(line: string): string {
  return (JSON.parse(line) as { rid: string }).rid;
}

describe("control helper", () => {
  test("correlates a reply to the request that asked for it", async () => {
    const fake = fakeProcess();
    const helper = createControlHelper(() => fake.process, { probe: () => binary(1) });

    const first = helper.request("desktop-audit");
    const second = helper.request("ax-ping");
    expect(fake.written).toHaveLength(2);

    // Answered out of order on purpose: the rid is what pairs them up, not arrival order.
    fake.emit(KIND_CONTROL, { type: "result", rid: ridOf(fake.written[1]!), ok: true, value: { inputTrusted: true } });
    fake.emit(KIND_CONTROL, { type: "result", rid: ridOf(fake.written[0]!), ok: true, value: { windows: [] } });

    expect(await second).toEqual({ inputTrusted: true });
    expect(await first).toEqual({ windows: [] });
    helper.stop();
  });

  test("rejects with the helper's reason code, not a message", async () => {
    const fake = fakeProcess();
    const helper = createControlHelper(() => fake.process, { probe: () => binary(1) });

    const pending = helper.request("composer-read");
    fake.emit(KIND_CONTROL, { type: "result", rid: ridOf(fake.written[0]!), ok: false, reason: "composer-missing" });

    await expect(pending).rejects.toThrow(ControlHelperError);
    await pending.catch((error: ControlHelperError) => {
      expect(error.reason).toBe("composer-missing");
    });
    helper.stop();
  });

  test("times out a request the helper never answers", async () => {
    const fake = fakeProcess();
    const helper = createControlHelper(() => fake.process, { probe: () => binary(1), timeoutMs: 10 });

    await expect(helper.request("desktop-audit")).rejects.toThrow("helper-timeout");
    helper.stop();
  });

  test("fails the request and retires the helper when a write fails after it returned", async () => {
    // A full pipe makes Bun's write answer later, so a dead helper shows up as a rejection rather
    // than a throw at the call.
    const fake = fakeProcess();
    const gone = new Error("broken pipe");
    const process: HelperProcess = { ...fake.process, write: () => Promise.reject(gone) };
    const helper = createControlHelper(() => process, { probe: () => binary(1) });

    await expect(helper.request("desktop-audit")).rejects.toBe(gone);
    expect(fake.killed).toBe(true);
    helper.stop();
  });

  test("routes an uncorrelated event to push handlers rather than to a waiter", async () => {
    const fake = fakeProcess();
    const helper = createControlHelper(() => fake.process, { probe: () => binary(1) });
    const seen: Record<string, unknown>[] = [];
    helper.onPush((event) => seen.push(event));

    const pending = helper.request("composer-observe");
    // No rid: an observer notification, which must not resolve the request in flight.
    fake.emit(KIND_CONTROL, { type: "composer-changed", pid: 61990 });
    await settle();

    expect(seen).toEqual([{ type: "composer-changed", pid: 61990 }]);
    fake.emit(KIND_CONTROL, { type: "result", rid: ridOf(fake.written[0]!), ok: true, value: {} });
    expect(await pending).toEqual({});
    helper.stop();
  });

  test("reads capabilities from the open frame", async () => {
    const fake = fakeProcess();
    const helper = createControlHelper(() => fake.process, { probe: () => binary(1) });

    const pending = helper.capabilities();
    fake.emit(KIND_META, {
      type: "open",
      mode: "control",
      inputTrusted: true,
      screenRecordingTrusted: false,
      composerVersion: 1,
    });

    expect(await pending).toEqual({
      inputTrusted: true,
      screenRecordingTrusted: false,
      composerVersion: 1,
    });
    helper.stop();
  });

  test("respawns when the binary underneath it was rebuilt", async () => {
    const spawned: ReturnType<typeof fakeProcess>[] = [];
    let mtimeMs = 1;
    const helper = createControlHelper(
      () => {
        const fake = fakeProcess();
        spawned.push(fake);
        return fake.process;
      },
      { probe: () => binary(mtimeMs) },
    );

    ignore(helper.request("desktop-audit"));
    expect(spawned).toHaveLength(1);

    // Same build: joins the running helper.
    ignore(helper.request("desktop-audit"));
    expect(spawned).toHaveLength(1);

    // A changed helper was installed. The next request must use that generation.
    mtimeMs = 2;
    ignore(helper.request("desktop-audit"));
    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.killed).toBe(true);
    helper.stop();
  });

  test("fails every request in flight when the helper exits", async () => {
    const fake = fakeProcess();
    const helper = createControlHelper(() => fake.process, { probe: () => binary(1) });

    const pending = helper.request("desktop-audit");
    // The idle watchdog firing looks exactly like this from here.
    fake.end();

    await expect(pending).rejects.toThrow("helper-exited");
    helper.stop();
  });

  test("spawns a replacement after an exit instead of staying dead", async () => {
    const spawned: ReturnType<typeof fakeProcess>[] = [];
    const helper = createControlHelper(
      () => {
        const fake = fakeProcess();
        spawned.push(fake);
        return fake.process;
      },
      { probe: () => binary(1) },
    );

    const first = helper.request("ax-ping");
    spawned[0]!.end();
    await expect(first).rejects.toThrow("helper-exited");

    ignore(helper.request("ax-ping"));
    expect(spawned).toHaveLength(2);
    helper.stop();
  });

  test("refuses when the helper has not been installed", async () => {
    const helper = createControlHelper(() => fakeProcess().process, {
      probe: () => ({ path: "/fake/grid-encoder", mtimeMs: 0, exists: false }),
    });

    await expect(helper.request("ax-ping")).rejects.toThrow("just grid-encoder-install");
  });
});
