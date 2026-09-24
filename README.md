# Annotate Export

Chrome extension (Manifest V3). Click a container on any page, write what is wrong, export a Markdown brief your agent can act on. No screenshots, no flow description.

## Use

1. Load unpacked: `chrome://extensions`, Developer mode, select `dist/`.
2. Press the toolbar button to toggle annotate mode (`Alt+Shift+A` command also registered, rebind at `chrome://extensions/shortcuts` on conflict).
3. Hover dims the page and highlights the picked container. The Mode button chooses Element or Shot before you click: Shot captures the element first, then opens the form with the shot armed. Click it, write the comment, pick a tag, Save. Click a list item to jump back to its element. ✓ marks done as you with a cross-off, ↩ reopens, ✕ removes the item, ↪ replies to the agent in a thread, Clear wipes the tab and the store for the page. User resolutions sync to the server as `resolvedBy` user, distinct from agent ones.
4. `Copy Markdown` pastes the brief into your agent. `Download .md` saves `annotate-brief.md`.

Each item carries selector, DOM path, classes, text, component hint, bounding box, and computed styles. Markers are tag colored: red bug, green suggestion, amber question. The dot in the bar shows agent bridge status: green connected, red offline, gray unknown.

## Agent MCP

`just mcp` runs the server: stdio MCP for local agents, localhost bridge on port 3847 for the extension, plus a stateless Streamable HTTP MCP endpoint at `POST /mcp` for portable clients. Every annotation records its page URL. Agents scope to their own site with the `url` substring filter on `agentdesk-annotator_list` and `agentdesk-annotator_brief`. Trust based in v1: no per-agent auth, the agent passes its own site URL.

Local clients: `claude mcp add -s user agentdesk-annotator -e ANNOTATE_PORT=3847 -- /ABS/PATH/annotate-export/mcp-server.js`, or copy `mcp.example.json` into your client's MCP config with the real path. Already registered here for Claude Code user scope and OpenCode global. Tools: `agentdesk-annotator_list`, `agentdesk-annotator_get`, `agentdesk-annotator_brief`, `agentdesk-annotator_resolve`, `agentdesk-annotator_reopen`, `agentdesk-annotator_screenshot`, `agentdesk-annotator_elements`. Resolve takes an optional message stored as an agent reply, reopen takes an optional why message while staying open. Replies and resolver identity sync into the panel under each item.

Portable (Claude Add custom connector dialog): the dialog needs a public HTTPS MCP URL, and Claude connects from Anthropic cloud, not your laptop. Local `http://127.0.0.1:3847/mcp` will not reach. Expose it with a tunnel, then paste the tunnel URL plus `/mcp`:

```
cloudflared tunnel --url http://127.0.0.1:3847
# or: ngrok http 3847
# paste: https://<tunnel-host>/mcp
```

Leave OAuth empty. `ANNOTATE_TOKEN` enables Bearer auth on `/mcp` only, but the Claude dialog has no static Bearer field, so keep it empty for connector use and treat the random tunnel hostname as the capability. Rotate by restarting the tunnel. `GET /mcp` returns 405 by design (no SSE stream offered); notifications return 202; bad browser Origins return 403.

## Screenshots

The 📷 button on any item captures the visible tab, crops to the element at device pixel ratio, downscales past 1200px, and uploads JPEG plus a bounded coverage dump: descendants up to depth 6, 80 nodes max, scripts and zero-area nodes skipped, files in `screenshots/`. `agentdesk-annotator_screenshot` returns the image plus coverage counts. `agentdesk-annotator_elements` filters the dump by substring, exact tag, and limit (default 40, max 200) so the agent pulls a bounded slice instead of the whole tree. Activating annotate mode pulls open items for the current URL, so annotations survive page reloads while the server runs. Data lives in `annotations.json` next to the server.

## Daemon

`com.annotate-export.bridge.plist` runs the server at login via launchd with KeepAlive, bridge on port 3847, logs in `bridge.log`. Installed as a symlink in `~/Library/LaunchAgents`. Re-apply after edits with `just install-daemon`. Singleton by design: each starter records its pid and role in `mcp-server.pid`, and a new stdio instance retires a live stdio predecessor after verifying it is ours. The daemon role is exempt in both directions, so launchd never wars with agent sessions. Agent-spawned server copies share the same `annotations.json`; if the daemon already owns port 3847 they log a warning and serve stdio only.

## Layout

`manifest.json` extension manifest. `background.js` badge plus toggle relay.
`format.js` shared brief builder, also required by tests. `content.js` picker
plus overlay UI in Shadow DOM. `popup.html` plus `popup.js` toolbar actions.
`store.js` JSON file store. `mcp-server.js` MCP stdio server plus ingest bridge.
`mcp.example.json` client config sample. `test/brief.test.js` node assertions
on the builder. `test/store.test.js` assertions on the store.

## Tasks

`just check` validates manifest JSON, syntax checks JS and the stamp script, runs both tests.
`just mcp` runs the agent server. `just pack` syncs runtime files into `dist/` and bakes a build stamp (content hash plus timestamp, git count plus sha when available) shown on the extensions detail page, the popup footer, and the bar tooltip. No manual version bump needed.
