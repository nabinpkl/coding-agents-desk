import { timingSafeEqual } from "node:crypto";
import { jsonResponse } from "./httpResponses.ts";

export function authorizeApiRequest(request: Request, expectedToken: string | null): Response | null {
  if (!expectedToken) {
    return jsonResponse({ error: { code: "sidecar-auth-unconfigured", message: "sidecar authentication is not configured", retryable: false } }, 503);
  }
  const authorization = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return unauthorized();
  const supplied = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return unauthorized();
  return null;
}

function unauthorized(): Response {
  return jsonResponse({ error: { code: "unauthorized", message: "valid sidecar capability required", retryable: false } }, 401);
}
