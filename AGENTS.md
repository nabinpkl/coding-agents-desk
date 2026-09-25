# AGENTS.md: agentdesk-annotator

Type: daily tool for one owner. It is done when the owner annotates a page in Chrome and an agent (claude.ai, Claude Code, OpenCode, on the mac or on oracle) reads that annotation over MCP from `https://annotator.example.com/mcp`, fixes it, and resolves it.

## Architecture

```
Chrome extension ─┐
claude.ai ────────┤  OAuth access token (Cloudflare Access Managed OAuth, owner email only)
Claude Code ──────┤
OpenCode ─────────┘
        │
Cloudflare Access (annotator.example.com) → tunnel annotator-oracle → server container on oracle
        │  Cf-Access-Jwt-Assertion
server: auth/access-jwt → /mcp (MCP SDK) and /api/v1 (extension) → service → store (SQLite)
```

- `shared/`: wire types as zod schemas (`annotation.ts`), zod-free enum vocabularies (`vocab.ts`, safe for the page bundle), and the Markdown brief (`brief.ts`).
- `server/src/`: `config.ts` (env, fails at boot), `store/` (node:sqlite, migrations, the only code that touches SQL), `service/annotations.ts` (use cases and invariants), `auth/access-jwt.ts`, `mcp/` (tools and endpoint), `http/` (Hono app and REST routes), `main.ts`, `backup.ts`.
- `extension/`: MV3. `src/background.ts` is the only code that talks to the server; `src/auth.ts` is the OAuth client; `src/content/` is picker, capture, panel view, and controller; `src/popup.*`.
- `deploy/`: Dockerfile, compose (server plus cloudflared), `.env.example`, `cloudflare.md` (resource ids, no secrets).
- `e2e/`: suite against the live edge, authenticated with the `annotator-e2e` service token.

## Rules that hold the design together

- Layering: `http` and `mcp` are adapters. They validate input with the shared zod schemas, call `service`, and shape output. `service` owns invariants and depends only on the `AnnotationStore` interface. Only `store/` touches SQLite.
- There is no unauthenticated mode. Every route except `GET /health` requires a valid Access JWT from an allowlisted email or service token. Do not add a bypass, a dev flag, or a trusted network.
- Actor semantics: `/api/v1` acts as `user` and MCP tools act as `agent`. `resolvedBy` and replies depend on this.
- A missing id throws `NotFound` (404 or an MCP tool error). Never return a silent null.
- The server is the only home for annotations. The extension keeps no local copy. Text the user typed stays in its field until the server accepts it.
- Every origin the extension calls must be in `manifest.json` `host_permissions`. The list lives in `extension/src/origins.ts` and the build enforces it. Without host access, Chrome sends `Origin: chrome-extension://<id>`, and Cloudflare Access refuses OAuth registration and token requests ("Origin not allowed"). With host access, Chrome sends no Origin.
- Tool names stay `agentdesk-annotator_*`. Agents and prompts depend on them.
- Migrations in `store/migrations.ts` are append-only.

## Conventions

- TypeScript on Node 24. The server runs `.ts` directly (type stripping), so use erasable syntax only: no enums, no parameter properties, no namespaces. Imports carry the `.ts` extension.
- The extension is bundled by esbuild (`extension/build.ts`). Content and popup bundles are IIFE, the service worker is ESM. The content bundle must not import zod: take enums from `shared/vocab.ts`.
- Panel and popup: colors are tokens in `styles.ts` / `popup.css`. Every button has hover, focus-visible, active, disabled, and busy states. Page and user text reaches the DOM only through `textContent`.
- Dependencies are pinned exactly. Vet any new one (recent release, human maintenance, adoption) before adding it.

## Commands

- `just check`: typecheck (server and extension), `node --test` for the server, extension build.
- `just e2e`: live edge suite from the mac (reads `~/.config/agentdesk-annotator/e2e.env`).
- `just deploy`: pull on oracle, `docker compose up -d --build`, then run e2e on oracle.
- `just logs`, `just backup` (SQLite `VACUUM INTO` inside the data volume).

## Response completion

Agent responses end with exactly three concrete next directions that the user may freely ignore.
