# docs/agents

Operating detail for agents working in this repository, by situation. The root `AGENTS.md` holds the
rules that apply to every change and says when to read each file here.

Until 2026-10-17 all of this was one `AGENTS.md`, which had grown to 126 KB while Codex reads only
the first 32 KiB of it. The sections moved with their text and headings unchanged. A reference
elsewhere in the tree to `AGENTS.md` "<heading>" names one of these:

| Section | Now in |
| --- | --- |
| Scroll and slide direction | `packages/AgentPanel/Web/AGENTS.md` |
| Two input paths, and they can both be live | `packages/AgentPanel/Web/AGENTS.md` |
| Panel state: what is remembered, and where | `packages/AgentPanel/Web/AGENTS.md` |
| Live data a widget shows lives in a store, not in `App` | `packages/AgentPanel/Web/AGENTS.md` |
| What an edit costs the open panel | `packages/AgentPanel/Web/AGENTS.md` |
| TypeScript-first glue and logging | `agent-feed/sidecar/AGENTS.md` |
| A channel that is turned off without being awaited will race its own re-opening | `agent-feed/sidecar/AGENTS.md` |
| And under Bun, a watch you close poisons the NEXT watch on that path | `agent-feed/sidecar/AGENTS.md` |
| And then the per-file watches went minutes late anyway, so the index stopped watching | `agent-feed/sidecar/AGENTS.md` |
| Reach for an event first, and a poll last | `agent-feed/sidecar/AGENTS.md` |
| Browser testing | `docs/agents/browser-testing.md` |
| Claude's own files are read-only, and its credentials are off limits | `docs/agents/claude-files.md` |
| An absent result is a claim about the probe until a second look agrees | `docs/agents/debugging.md` |
| `log show` answers nothing here, so os_log is a live channel and not a record | `docs/agents/debugging.md` |
| The virtual display | `docs/agents/desktop-and-display.md` |
| Running commands in the agent session | `docs/agents/desktop-and-display.md` |
| Display capture | `docs/agents/desktop-and-display.md` |
| Bringing the current path up | `docs/agents/dev-loop.md` |
| A restart used to hand this Mac back the SHIPPED configuration | `docs/agents/dev-loop.md` |
| The dev origin is HTTPS over the tailnet, and that is load-bearing | `docs/agents/dev-loop.md` |
| The dev origin serves HTTP/2, and it is load-bearing | `docs/agents/dev-loop.md` |
| Durable runtime and disposable builds | `docs/agents/dev-loop.md` |
| How long a file gets, and how flat a directory gets | `docs/agents/file-and-directory-caps.md` |
| Where sessions run, and where they are watched | `docs/agents/sessions-and-tmux.md` |
| The opencode serve is one per machine, and its plugins load hot | `docs/agents/sessions-and-tmux.md` |
| A session you spin up to PROBE is a throwaway, and the machinery is checked in | `docs/agents/sessions-and-tmux.md` |
| Several sessions share one branch, so re-read before you trust anything | `docs/agents/shared-branch.md` |
| An argv flattened into a shell string must be quoted per argument | `docs/agents/shell-scripts.md` |
| A delete names an absolute path, and preferably one this run created | `docs/agents/shell-scripts.md` |
| Phase-lane implementor-reviewer loop | `docs/agents/workers-mode.md` |
| Seven things `FEATURE-MAP.md` exists to stop you getting wrong (in full) | `FEATURE-MAP.md` |
| The native client, host builds, and the simulator are dormant | root `AGENTS.md`, "Hardware is a checkpoint", with the detail in `docs/dormant-native.md` |
| Subagents Work Mode | root `AGENTS.md`, "Subagents", with roles and the loop in `docs/agents/workers-mode.md` |
