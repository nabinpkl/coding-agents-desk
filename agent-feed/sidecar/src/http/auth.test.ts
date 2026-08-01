import { expect, test } from "bun:test";
import { authorizeApiRequest } from "./auth.ts";

test("every API request requires the exact host capability", () => {
  expect(authorizeApiRequest(new Request("http://localhost/api/projects"), "secret")?.status).toBe(401);
  expect(authorizeApiRequest(new Request("http://localhost/api/projects", { headers: { authorization: "Bearer wrong" } }), "secret")?.status).toBe(401);
  expect(authorizeApiRequest(new Request("http://localhost/api/projects", { headers: { authorization: "Bearer secret" } }), "secret")).toBeNull();
  expect(authorizeApiRequest(new Request("http://localhost/api/projects"), null)?.status).toBe(503);
});

test("sidecar responses do not grant browser CORS access", async () => {
  const response = authorizeApiRequest(new Request("http://localhost/api/projects"), "secret")!;
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});
