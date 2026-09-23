// Reading one environment variable, and refusing the value rather than working around it.
//
// Every setting the sidecar takes from the environment comes through one of these four, so a
// malformed value fails at startup with the variable's own name in the message instead of
// surfacing later as a port of NaN or a URL nobody can fetch. A missing value is not malformed:
// it takes the fallback, which is what makes every one of these optional.

import { resolve } from "node:path";

export function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function booleanEnvironment(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  throw new Error(`${name} must be "true" or "false"`);
}

export function urlEnvironment(name: string, fallback: string): URL {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`${name} must be a valid http(s) URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return parsed;
}

export function directoryEnvironment(name: string, fallback: string): string {
  const raw = process.env[name];
  return resolve(raw === undefined || raw === "" ? fallback : raw);
}
