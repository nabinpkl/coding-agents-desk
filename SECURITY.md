# Security

AgentDesk controls a Mac: it starts coding agents, types into their sessions, opens terminals, edits
files and, with the optional capture helper, moves the pointer. It does not ask anyone to log in.
This page describes the limits on who can reach it, the callers the limits do not stop, what it
sends off the Mac, and how to report a vulnerability.

## Actions open to anyone who reaches the panel

The panel and the sidecar behind it do not authenticate requests. The sidecar's API does not read
an `Authorization` header and serves every request that reaches it. Anyone who can send requests to
the panel can:

- read the transcripts of your agent sessions, and type into any of those sessions;
- start Claude Code sessions. They open in Claude Code's `auto` permission mode with "bypass
  permissions" available, so an agent started there runs commands without asking
  (`AGENT_FEED_CLAUDE_PERMISSION_MODE` and `AGENT_FEED_CLAUDE_ALLOW_BYPASS` change both);
- open your tmux panes and type into them, which is a shell running as you;
- read and write files through the IDE tab;
- see the screen and send pointer and keyboard input, once the capture helper is installed.

## Limits on who can reach the panel

The addresses the panel and the sidecar listen on are the boundary, and two checks on each request
keep web pages out:

- **The sidecar** listens on `127.0.0.1` (`AGENT_FEED_HOST`), so only processes on the Mac can
  connect to it.
- **The panel's dev server** listens on the addresses `AGENTDESK_PANEL_LISTEN` selects. `loopback`,
  the default, is the Mac only. `tailnet` adds the Mac's Tailscale address, where Tailscale's
  device authentication and encryption take the place of a login. `network` serves every network
  the Mac is on, in plain HTTP, to anyone on it.
- **Requests from web pages are checked.** A page open in your browser can send requests to
  `127.0.0.1`. The sidecar and the panel's dev server both refuse a request whose `Host` header is
  not one of their own names, which turns away a page whose domain was made to resolve to
  `127.0.0.1`. They also refuse a request whose `Sec-Fetch-Site` header marks it as sent by a page
  from another origin. The panel's dev server applies the same two checks to the WebSocket that
  relays the Screen tab to macOS Screen Sharing.
- **The Screen tab** reaches macOS Screen Sharing, which asks for a macOS account's name and
  password itself.

## Callers these limits do not stop

- **Every process on the Mac**, whichever user it runs as, can connect to `127.0.0.1`.
- **In `tailnet` mode, every device that your tailnet's access rules allow to reach the Mac's port
  5173**, including the devices of people you have shared the Mac with in Tailscale. Tailscale's
  access rules can narrow that list.
- **In `network` mode, every device on the network.**
- **A sidecar on a second machine** (`just remote-sidecar-run`) listens on that machine's tailnet
  address, so there the tailnet is the only boundary.
- **The proxy observer relay** (`just proxy-observer-relay`) puts Claude Code's captured API
  traffic, prompts and responses included, on the tailnet for a second machine to read.

## Data sent off the Mac

The agents send their own traffic to their model providers. AgentDesk itself sends only the items
below:

- The **Summarize** button sends a turn's transcript to the model named by
  `AGENT_FEED_SUMMARY_PROVIDER` and `AGENT_FEED_SUMMARY_MODEL`, with `AGENT_FEED_SUMMARY_API_KEY`.
  Without the key the feature is off.
- With an OpenCode Go key in opencode's own `auth.json`, the sidecar requests the plan's usage from
  opencode.ai with that key, for the panel's usage meters.
- **Push notifications**, once you turn them on in a browser, go through that browser maker's push
  service, encrypted with the Web Push protocol.
- **Error and timing reports** from the panel and the sidecar stay on the Mac, in
  `/Users/Shared/agentdesk/logs/` (`AGENTDESK_TELEMETRY_ARCHIVE`). They are made with Sentry's
  SDKs, configured with a placeholder URL that delivers them to the sidecar, so the reports are not
  sent to Sentry.

## Settings meant for development only

- `AGENTDESK_AUTO_APPROVE=1`, which `.env.example` sets, makes the Mac app approve an iPhone's
  pairing request without asking when the app was launched by `just host-run`. Remove it from
  `.env` on a Mac that other people's devices can reach.
- `network` mode, described above.

## Vulnerability reports

Report a vulnerability privately through GitHub: on this repository's **Security** tab, choose
**Report a vulnerability**. Please do not open a public issue for it.
