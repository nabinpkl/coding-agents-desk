---
name: group-api-design
description: Use when adding or changing any HTTP endpoint, request or response shape, error, stream or status code in Group (the group chat tab's server process, reached at /api/group/), or the panel code that calls it. Group's API follows Zalando's RESTful API Guidelines (MUST rules always, SHOULD rules unless this skill records otherwise), defined contract-first with Effect's HttpApi and Schema. Code elsewhere in this repository is never a reason to depart from them.
---

# Group's API

Group's API follows the **Zalando RESTful API Guidelines** (`.reference/zalando-api-guidelines`, a
full clone; `chapters/*.adoc` holds every rule under its number). The rules cited here are adapted
from them: Zalando SE, "Zalando RESTful API and Event Guidelines",
https://opensource.zalando.com/restful-api-guidelines/, licensed CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/); this skill selects and restates rules and adds
Group's own, so it is a changed version.

Why this one: its rules are numbered and graded MUST, SHOULD and MAY, so a review can cite one and
a linter can check it, and its licence is clear. Google's AIP is gRPC-first and Microsoft's
guidelines lean on OData; neither fits a small JSON-over-HTTP API between a panel and its server.

## No escape hatch

- **Every MUST rule applies,** except the few below that concern infrastructure Group does not
  have. That list is decided once, here, with its reasons; nothing else is skipped.
- **A SHOULD rule applies** unless this skill records why not, dated.
- **Existing code is not a reason.** The sidecar's routes match paths by hand, return camelCase
  JSON and invent their own error shapes; none of that is a precedent. "The rest of the API does it
  this way" justifies nothing here. If a rule is wrong for Group, change this skill first, with the
  reason, then the code.

Out of scope (approved by the owner 2026-10-25), because Group has no counterpart: the events chapter (Zalando's Nakadi event bus;
Group's room stream is below), OAuth permission scopes (#105, #225: Group is reached on loopback
behind the sidecar's own boundary), API registry metadata (#218, #215, #219), hostname conventions
(#224), partner approval and consent before a shutdown (#185, #186), `X-Flow-ID` (#233), and the
money and address objects (#173, #249).

## Contract first

- **The API is written before its implementation** (#100) as an Effect `HttpApi`
  (`.reference/effect/packages/effect/src/http-api/`): each endpoint's path, parameters, payload,
  success and error schemas in one place. The server's handlers implement that contract; the
  panel's calls are typed from it.
- **OpenAPI is published** (#101, #192): generated from the contract with `OpenApi.fromApi` (3.1),
  served at `/api/group/openapi.json`. Nobody writes it by hand.
- **Specify every success and error response** (#151) in the contract.

## Resources and URLs

- **Resources, not actions** (#138, #141): no verbs in paths. Stopping a wave changes the wave's
  state (`PATCH /api/group/rooms/{room_id}/waves/{wave_id}` with `{"status": "stopping"}`), or makes
  a resource (a stop request), never `POST .../stop`.
- **Plural, kebab-case names** (#134, #129); sub-resources as path segments (#143):
  `/api/group/rooms/{room_id}/members`, `/api/group/rooms/{room_id}/messages`.
- **snake_case query parameters** (#130), conventional names (#137: `cursor`, `limit`, `sort`),
  normalized paths with no trailing slash (#136), URL-friendly ids (#228).
- **Methods used for what they mean** (#148, #149): `GET` reads and is safe, `PUT` and `DELETE` are
  idempotent, `POST` creates.

## Payloads

- **JSON, top-level objects** (#167, #110): never a bare array, so a field can be added later.
- **snake_case property names** (#118), approved by the owner 2026-10-25 knowing the rest of the
  panel's wire is camelCase. Group's TypeScript keeps camelCase and renames at the boundary with
  `Schema.encodeKeys` (`packages/effect/src/Schema.ts`).
- **`null` and absent mean the same** (#123); no `null` booleans (#122).
- **Standard formats** (#238, #169, #171): RFC 3339 date-times, and a declared format for every
  number and integer.
- **Compatible changes only** (#106, #108, #111): add, never remove or repurpose a field; a client
  ignores what it does not know. No versions in the URL (#115), and avoid versioning at all (#113)
  while compatibility holds.

## Errors

- **Problem JSON** (#176): every error is `application/problem+json` with `type`, `title`,
  `status`, `detail` and, for Group, an `instance` naming the room, wave or member. Each is a
  `Schema.TaggedError` in the contract, mapped to its status in one place.
- **The most specific official status** (#243, #220, #256): a full budget is `429`, sent with its
  headers (#153), not a 500; a room that does not exist is `404`; a message refused for its content
  is `400` or `422`; a wave already stopping is `409`.
- **No stack traces, payloads or identities in an error** (#177), the same rule as the
  `group-effect` skill's safe attributes.

## Writes that may be repeated

- **POST is made idempotent** (#229) with an `Idempotency-Key` header (#230): posting a message twice
  after a retry or a reload lands it once. The key is stored with the message in the room log.
- **Delivery to an agent is at most once** (invariant 4 in the design doc): an idempotent post never
  becomes a second paid turn.

## Reading: pages and the room stream

- **Cursor pagination** (#159, #160) with a page object and links (#248, #161), and no total count
  (#254). A room log's cursor is its message number.
- **The room stream** is `GET /api/group/rooms/{room_id}/messages` with `Accept: text/event-stream`:
  one event per message, its `id` the message number, so a reader that comes back sends
  `Last-Event-ID` and resumes with nothing missed or repeated. Zalando's events chapter does not
  cover streaming to a reader, so this is Group's own rule, consistent with the cursor above.
- **The stream is a reader's, the work is the room's:** closing a stream ends only that stream
  (principle 5, `group-effect`).

## Before you hand off

- Is the endpoint in the `HttpApi` contract, with every success and error schema?
- Is the path plural, kebab-case and verb-free, and are JSON properties and query parameters
  snake_case?
- Does every error carry problem JSON and its most specific status?
- Can every `POST` be repeated safely?
- Did anything depart from a rule because existing code does it differently? That is not a reason.
