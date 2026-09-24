# AGENTS.md — annotate-export

Type: daily tool. Done when the owner annotates one page and an agent fixes from the pasted brief today.

## v0 scope (shipped 0.1.x) plus v1 bridge (0.2.0)

Content-script picker, dim plus highlight hover, comment box with tag, in-page list with click-to-locate, Copy Markdown plus Download .md. MCP stdio server plus localhost ingest bridge. Annotations record page URL, agents scope by `url` substring filter, trust based with no per-agent auth. Activating annotate pulls open items for the URL, so annotations survive reloads while the server runs.

## Deferred

Walk steps, source file mapping, per-agent auth, cross-page sessions in the panel.

## Conventions

Vanilla JS, no build step, no dependencies. UI in Shadow DOM. Shared brief builder in `format.js`, required by node. Store in `store.js`, protocol plus HTTP in `mcp-server.js`. `dist/` holds browser runtime files only, synced by `just pack`.

## Response completion

Agent responses end with exactly three concrete next directions that the user may freely ignore.
