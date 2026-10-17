# Claude's own files

Moved out of the root `AGENTS.md` on 2026-10-17 with the text unchanged. The root file still applies.

## Claude's own files are read-only, and its credentials are off limits

Recorded 2026-09-15, on the owner's word, after a feature of ours reached for a status-line mirror
it should not have.

- **Never touch the OAuth token, and never authenticate as the reader.** `~/.claude/.credentials.json`,
  the `oauthAccount` block in `~/.claude.json`, and the keychain entries beside them belong to
  Claude Code, and a panel that borrowed them would be making API calls as the person using it. Do
  not read them, copy them, mint a request with them, or design a feature that needs them. The rest
  of that file -- `organizationRateLimitTier`, the caches, the project list -- is a readable fact
  about the machine; the credentials are not.
- **Two sources, and they are the only two.** The jsonl transcripts under `~/.claude/projects/`,
  read-only, which is where the whole timeline already comes from; and the HTTPS proxy Claude Code
  itself supports (`HTTP_PROXY`, observed through proxy-agent's viewer API, see
  `live/claudeNetworkSource.ts`), which is an intended mechanism rather than a way around one.
  Anything a feature needs about a live session comes from one of those two or is not available.
- **Write nothing into `~/.claude/`, and edit nothing Claude owns.** Not `settings.json`, not
  `~/.claude.json`, not its status-line command, its hooks, its plugins, its sessions registry, or
  any state file under that directory. Reading is fine; changing is not, however small. The panel
  is a viewer of somebody else's tool: a viewer that rewrites its subject's configuration breaks on
  the CLI's next release, changes behaviour the reader never asked for, and leaves nobody able to
  say which of the two wrote what.
- **The shape this rule exists to stop.** Claude publishes the five-hour and weekly rate limits
  only on API response headers, and its own on-disk copy of them (`cachedUsageUtilization` in
  `~/.claude.json`) is absent for long stretches -- measured absent entirely on this machine, and
  from every rotated backup, while sessions ran all day. The first design for the panel's limit
  meters asked the owner to point `statusLine.command` at a script of ours so the numbers would be
  written somewhere readable: a config edit inside the reader's Claude install, for our
  convenience. The supported answer was already running, and the same headers cross the proxy on
  every request, unredacted. **If a feature seems to need Claude to write something for us, the
  source is wrong, not the permission.**
