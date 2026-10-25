---
status: accepted
date: 2026-10-25
---

# Node, npm and Bun come from mise alone, pinned exactly per repository

## Context and Problem Statement

Until 2026-10-25 this Mac took Node and npm from nvm and Bun from Homebrew's `oven-sh/bun` tap.
Upgrading Bun stalled on Homebrew refusing the untrusted tap; a global npm install landed inside
one nvm Node version's directory and vanished with it; and the login jobs' PATH recorded nvm's
versioned directory, which moved on every Node upgrade. The owner asked for one way to upgrade
every runtime at once, with whatever an upgrade breaks allowed to break rather than kept alive by a
fallback. This touches the owner's shell, the login jobs `just dev-login-install` writes, tmux's
global environment, and the `justfile` recipes that hand Bun to the Mac host.

## Decision Drivers

- One command upgrades every runtime everywhere.
- A repository runs the versions its gate passed on, and moves only in a commit.
- No second manager or compatibility path left in place: one source for each runtime.
- A path a login job records does not move when a runtime is upgraded.

## Considered Options

- **Option A**: mise for Node, npm and Bun; nvm and Homebrew's Bun removed.
- **Option B**: Homebrew's Node and Bun, nvm removed.
- **Option C**: fnm for Node beside Homebrew's or Bun's own installer for Bun.
- **Option D**: Volta.

## Decision Outcome

Chose **Option A**. mise (MIT, from Homebrew's core repository, released every day or two in
October 2026) is the only version manager. Its global config (`~/.config/mise/config.toml`) tracks
`node = "lts"` and `bun = "latest"`, so `mise upgrade` moves every project without a pin. This
repository's `mise.toml` pins exact versions, plain `[tools]` entries that need no `mise trust`.
Everything finds the runtimes through mise's shims (`~/.local/share/mise/shims`), first on the
owner's PATH, on the login jobs' PATH and on tmux's, which is where `AGENTDESK_BUN_PATH` points for
new sessions. The launch recipes ask Bun itself, from this tree, for its own path, so the host
starts the supervisor on the binary this repository pins, not on what the shim would pick for the
host's working directory. mise's support for other managers' files (`.nvmrc`, `.node-version`) is
off: a project without a `mise.toml` takes the global default.

Upgrading this repository: `mise upgrade --bump` here, then `just check-legs` on the new versions,
then commit `mise.toml`, then restart the dev loop so the host picks up the new path.

Option B is knocked out by the first driver (two tools would still each be upgraded their own way,
and the tap Homebrew refused is Bun's). Option C keeps two managers, against the third. Option D
reached end of maintenance in November 2025.

### Consequences

- Good, because one command upgrades every runtime, and a repository that breaks on an upgrade keeps
  its pin until its gate passes.
- Good, because the login jobs record a directory that does not move, so a runtime upgrade no
  longer needs `just dev-login-install` again.
- Bad, because everything installed with nvm's npm went with nvm: `codex`, `gemini`, `pi`,
  `agent-browser`, `playwright`, `uipro`, and nvm's `pnpm` and `yarn`. A CLI that is still wanted is
  reinstalled, through mise's `npm:` backend or a project's own dependencies.
- Bad, because a Claude Code session already running when the change landed keeps the PATH it
  started with, so `bun` and `node` are missing from its shell until it restarts; its mod servers
  keep running the removed Homebrew Bun from memory until it ends.
- Bad, because `brew uninstall bun` also autoremoved Homebrew's `python@3.14`, which nothing in this
  repository used (the speech process runs on uv's Python 3.13).
- Neutral, because the messaging hub's Docker image (`agent-feed/hub/deploy/Dockerfile`) and the
  remote sidecar peers keep their own Bun, outside this decision.

### Confirmation

- `ps` shows the supervisor, the sidecar and the audio process running
  `~/.local/share/mise/installs/bun/<the pinned version>/bin/bun`.
- `just check-legs` passes on the versions `mise.toml` pins, measured 2026-10-25 on Bun 1.4.4 and
  Node 24.22.1.

## Links

- `docs/agents/dev-loop.md`, "Runtimes come from mise"
- ADR-0156, whose Group package keeps its own tool versions inside the runtime this one provides
- https://mise.jdx.dev/dev-tools/shims.html, https://mise.jdx.dev/cli/upgrade.html,
  https://mise.jdx.dev/cli/trust.html (read 2026-10-25)
