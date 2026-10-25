# agentdesk-annotator

Click a container on any web page, write what is wrong, and hand agents a structured brief over MCP. The Chrome extension records the element's selector, DOM path, component hints, styles, bounding box, and an optional cropped screenshot with a bounded dump of the nodes it covers. Agents read and resolve annotations through the `agentdesk-annotator_*` MCP tools at one public URL:

```
https://annotator.example.com/mcp
```

That is your own host: the server runs wherever you deploy it (`deploy/`), behind Cloudflare Access (`deploy/cloudflare.md`), and `.env` names it for the extension and the e2e suite (`.env.example`). Every client signs in with OAuth through Access. Only the owner's email is allowed.

## Connect a client

- **claude.ai** (also Desktop and mobile): Settings, Connectors, Add custom connector, paste the URL above, then sign in with the emailed one-time code. Leave the OAuth client fields empty.
- **Claude Code**: nothing to add. Claude Code signed in to the same claude.ai account loads the connector above automatically (`claude mcp list` shows it as `claude.ai <the connector's name>`). Adding a local entry as well would duplicate every tool.
- **OpenCode**:

  ```bash
  opencode mcp add --global --url https://annotator.example.com/mcp agentdesk-annotator
  ```

  ```bash
  cd ~ && opencode mcp auth agentdesk-annotator
  ```

  Run the sign-in from the home directory: from a project folder OpenCode 2.0 reports the server as not found. It listens for the sign-in's return on a random local port, so on a machine without a browser, forward that port with `ssh -L PORT:127.0.0.1:PORT host` and open the printed URL on your own machine. After editing the config by hand, `opencode reload` makes the background service pick it up.

## Extension

1. Copy `.env.example` to `.env` and fill it in, then build with `just build-extension`, open `chrome://extensions`, turn on Developer mode, and choose Load unpacked with `extension/dist`. Allow `https://<id>.chromiumapp.org/` as a redirect on your Access application, with the id `chrome://extensions` shows: it is the only extension redirect Access accepts. With `ANNOTATOR_EXTENSION_KEY_FILE` set, the build prints the id and it stays the same wherever the folder is.
2. Click the toolbar button (or press `Alt+Shift+A`) to open the panel on the page, then click Sign in in the panel. There is no popup: the panel is the whole UI, including sign-out and the build stamp (hover the Annotate title).
3. The toolbar button toggles annotate mode, armed in the capture mode you used last, so one click is enough to start the next shot or region. Hover to highlight a container, click it, write the comment, pick a tag (`change` unless you pick another), and Save (`Cmd+Enter`). The form opens beside what you picked rather than over it, and its title bar drags it anywhere. Its Send to list starts at none, which keeps the annotation for later; pick a Bot session and Save becomes Save and send, handing that one annotation over at once. The send bar above the list sends everything kept back and not yet sent. In Shot mode the element is captured before the form opens. In Region mode, drag a rectangle over any part of the page, as with the macOS region screenshot; the area is captured and its page coordinates are stored with the annotation. On a clicked container, the form's Font size control (`−`/`+`, Shift for 4px, or type a size) changes that element's size on the page while the form is open, so you see the change before asking for it. Save records it as `font-size 14px → 18px` for the agent; Save and Cancel both put the page back.
   **Preview** (toolbar) tries several changes before saving any. While it is on, clicking an element opens a small editor instead of the comment form; each change applies at once and stays. A banner at the top and a coloured frame around the window say the page is modified. Hold `` ` `` (or Hold to compare) to see the page without your changes, Review lists them with undo, and Save turns them into annotations, one per element, with an optional shared note and a Send to choice. The draft is kept in the extension's storage per page, so it survives reloads, closed tabs and browser restarts; leaving preview only hides it, and Discard is the one thing that deletes it. Changes are drawn as stylesheet rules on the element's selector, so a page that re-renders keeps showing them, and a selector that matches several elements changes all of them (the editor says so).
4. In the list you can:
   - resolve or reopen an item;
   - reply to the agent;
   - take a screenshot;
   - delete an item;
   - click an item to scroll to its element.
5. While changing the extension, run `just watch-extension` instead of reloading by hand. It rebuilds `extension/dist` on every source change and reloads the unpacked extension. Pages with the panel open reload too, unless the comment form has text. Edits to `manifest.json` need the watcher restarted. A watch build carries dev-only reload code and shows `dev` in the panel's build stamp, so run `just build-extension` before using it for real.

   Copy and Download export the open items as Markdown.

## Tools

| Tool | What it does |
|---|---|
| `agentdesk-annotator_list` | Annotations, newest activity first, filtered by page URL substring and status |
| `agentdesk-annotator_get` | One annotation in full |
| `agentdesk-annotator_brief` | Markdown brief of open items for a URL |
| `agentdesk-annotator_screenshot` | The element screenshot as image content |
| `agentdesk-annotator_elements` | Covered DOM nodes, filtered by substring or tag, capped by limit |
| `agentdesk-annotator_resolve` | Mark fixed (resolvedBy agent), with an optional reply |
| `agentdesk-annotator_reply` | Add an agent reply without changing status (clarifying questions, debated approaches) |
| `agentdesk-annotator_reopen` | Reopen a resolved annotation that is not done, with an optional reason; refused on an open one |

## Operations

The server and a cloudflared tunnel run with docker compose on oracle (shipped tree at `~/.local/share/agentdesk/repo/agentdesk-annotator/deploy`). Data lives in the `annotator-data` volume as one SQLite file, screenshots included.

- `just deploy`: ship, rebuild, restart, then run the edge e2e suite.
- `just logs`: follow the server log (one JSON line per request, with the verified identity).
- `just backup`: consistent snapshot to `/data/backups/`.
- `just check`: typecheck, tests, and extension build locally.

The Cloudflare resources it needs and the rotation steps are in `deploy/cloudflare.md`; keep your own ids in `deploy/cloudflare.private.md`, which is gitignored. The Managed OAuth spike findings are in `docs/spike.md`.
