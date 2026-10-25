// Effect tests on `bun test`: `it.effect` runs on a TestClock, so time moves only with
// `TestClock.adjust`; `it.live` runs on the real clock, for real processes, sockets and files; and
// `testEffect(layer)` gives both with a layer of stand-ins provided. A test that reaches past
// loopback fails, whatever the code under test does with the error.
//
// Adapted from OpenCode's `packages/core/test/lib/effect.ts` at 1aae67e853 (2026-10-09),
// https://github.com/anomalyco/opencode, MIT License, Copyright (c) 2025 opencode. Changed: Effect
// imported as namespaces from subpaths, and `only` and `skip` left out.
import { test, type TestOptions } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";

type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>);

const body = <A, E, R>(value: Body<A, E, R>) => Effect.suspend(() => (typeof value === "function" ? value() : value));

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A test reached past loopback; each request it tried is listed. */
export class NetworkRefused extends Schema.TaggedError<NetworkRefused>()("NetworkRefused", {
  requests: Schema.Array(Schema.String),
}) {}

/** A `fetch` that passes loopback through and records, then refuses, anything else. */
export const refuseNetwork = (violations: string[]): typeof fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // This is the stand-in for `fetch` that Effect's HTTP client is given, so it calls the real one.
      // @effect-diagnostics-next-line globalFetch:off
      if (loopback.has(new URL(url).hostname)) return fetch(input, init);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const message = `test attempted network request: ${method} ${url}; provide an HttpClient stand-in`;
      violations.push(message);
      return Promise.reject(new Error(message));
    },
    { preconnect: fetch.preconnect },
  );

const run = <A, E, R, E2>(value: Body<A, E, R | Scope.Scope>, layer: Layer.Layer<R, E2>) =>
  Effect.gen(function* () {
    const violations: string[] = [];
    const exit = yield* body(value).pipe(
      Effect.scoped,
      Effect.provide(layer),
      Effect.provideService(FetchHttpClient.Fetch, refuseNetwork(violations)),
      Effect.exit,
    );
    if (Exit.isFailure(exit)) {
      for (const error of Cause.prettyErrors(exit.cause)) yield* Effect.logError(error);
    }
    if (violations.length > 0) return yield* new NetworkRefused({ requests: violations });
    return yield* exit;
  }).pipe(Effect.runPromise);

const make = <R, E>(testLayer: Layer.Layer<R, E>, liveLayer: Layer.Layer<R, E>) => ({
  effect: <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, options?: number | TestOptions) =>
    test(name, () => run(value, testLayer), options),
  live: <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, options?: number | TestOptions) =>
    test(name, () => run(value, liveLayer), options),
});

const testEnvironment = Layer.mergeAll(TestConsole.layer, TestClock.layer());

// The live environment keeps the real clock and still captures console output.
const liveEnvironment = TestConsole.layer;

export const it = make(testEnvironment, liveEnvironment);

export const testEffect = <R, E>(layer: Layer.Layer<R, E>) =>
  make(Layer.provideMerge(layer, testEnvironment), Layer.provideMerge(layer, liveEnvironment));
