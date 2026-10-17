---
status: superseded by ADR-0142
date: 2026-08-20
superseded-by: ADR-0142
---

# Address a CLI session by its inbox, not its window

## Context and Problem Statement

The Agent Panel can type into a Claude session that Claude Desktop is showing, because that session
has a window and the window has a text field the Accessibility API can read and write (ADR-0091's
window band). It cannot type into a Claude Code session running in a terminal, which is where most
of them run. Such a session shows in the feed, streams its transcript, reports its background
tasks, and offers a composer that is permanently disabled.

The obvious extension was to resolve the terminal the way the Desktop one is resolved: walk the
session's process up its parent chain to the application that owns its window, then drive that
window. `AgentWindowSessionResolver` already walks exactly that chain and already classifies these
sessions, as `.terminal`, and refuses them.

**The chain does not reach a window.** Measured on the development machine, two live CLI sessions in
two separate terminal windows:

```
61720 claude  ->  61183 -/bin/zsh  ->  61182 login  ->  35985 Ghostty
44871 claude  ->  44302 -/bin/zsh  ->  44301 login  ->  35985 Ghostty
```

One pid for both, because Ghostty renders every window, tab, and split in one process, as do
Terminal.app and iTerm2. The parent chain identifies the terminal APPLICATION and can never do
better. What separates the two sessions is the tty (`ttys018` and `ttys003`), and mapping a tty back
to a window is a per-emulator question: Terminal.app and iTerm2 answer it in AppleScript, Ghostty,
Alacritty, and WezTerm answer it nowhere. A window-shaped design would therefore work on some
terminals, fail silently on others, and never work through tmux or over ssh.

Affects the sidecar's session registry reader, the Agent Panel composer, and the wire.

## Decision Drivers

- The address of a session everywhere else in this feature is its session id. Input should not be
  the one place that needs a window, a Desktop, and a scriptable terminal.
- Failure has to be legible. A composer that silently does nothing on one terminal emulator and
  works on another is worse than one that says why it cannot send.
- No new authority. The panel can already open a terminal that resumes any session; input must not
  quietly grant more than that.

## Considered Options

- **Option A**: Resolve the terminal window from the process tree and inject synthetic keystrokes.
- **Option B**: The harness's per-session message inbox: a unix socket the session publishes, with
  an auth key beside it.
- **Option C**: Channels, the documented MCP push surface (`claude/channel`, `--channels`).

## Decision Outcome

Chose **Option B**.

Every live session writes `messagingSocketPath` into its own registry row under
`~/.claude/sessions/<pid>.json` and an auth key beside it as `<pid>.<sha256(socketPath)>.key`,
carrying a `peerToken`. The socket takes newline-delimited JSON: one `auth` line, then one `user`
line. So delivery is: session id, to a verified live pid, to that pid's socket, to two lines. No
window, no Accessibility, no focus, no Space move, and no terminal that has to be scriptable. It
works identically under tmux and over ssh, because none of those change what the process published.

Option A was rejected on the measurement above. Option C is the supported path and would be the
better one if the panel launched these sessions, but a channel must be opted into with `--channels`
when the session STARTS; it cannot reach a session a human already has running in a window, which is
the entire population this feature is for.

Three constraints shape the implementation.

**The socket path is discovered, never supplied.** It comes from a registry row this sidecar
verified against the kernel, exactly as ADR-0099 requires for task output paths. A caller-supplied
path would make the endpoint a write oracle over every unix socket the sidecar can open.

**The key is derived, not searched for.** Its name contains the hash of the socket path, so building
the name is what proves the token belongs to THIS session's socket. Choosing whichever key file
carries the right pid would hand one session's token to another's inbox after a pid is reused, and
the same `procStart` check the registry row gets is applied to the key.

**Not delivered is an answer, not an error.** The route returns 200 with `delivered: false` and a
reason when a session is not running, publishes no inbox, or has stopped listening. Those are facts
the composer renders; only a malformed request (empty turn, oversized turn, non-JSON body) is 4xx.

The panel selects its composer on the session's `entrypoint`, which the registry states. A `cli`
session gets a local draft and one Send. A `claude-desktop` session keeps the window band, even
though its inbox works too: it has a real field to mirror, and mirroring it is strictly more than
delivering to it.

### Consequences

- Good, because input now works on every terminal, including ones with no scripting surface at all,
  and through tmux and ssh.
- Good, because the failure modes are named and rendered instead of being a field that does nothing.
- Good, because no Accessibility permission, window focus, or Desktop switch is involved, so nothing
  the user is looking at moves when a phone sends a turn.
- Bad, because the protocol is the harness's own and is not a published API. It is gated, so a
  session can legitimately have no inbox, which is why `no-inbox` is a first-class reason rather
  than an error; and a harness release could change the wire under us. The blast radius is this one
  module and the composer band it feeds.
- Bad, because a delivered turn is not an accepted turn. The harness may hold a peer's message for
  the recipient's approval, and it reports that verdict to the SENDER's own inbox, which we do not
  have. `delivered` therefore means the bytes landed, and the wire type says so. What happened next
  is visible where it is anyway: the transcript the panel is already streaming.
- Neutral on authority. The panel could already resume any session into an AgentDesk-owned terminal,
  which is strictly more powerful than putting one turn into a running one. The reach is the same
  set of sessions the feed already lists.
- Neutral that a Desktop session also has an inbox. It is reported honestly and left unused; whether
  the window composer should eventually become a reader over one delivery path is a separate
  question with its own evidence to gather.

### Confirmation

`claudeSessionInbox.test.ts` pins the key-name derivation (including two sockets under one pid and
the relative-path canonicalisation), the two-line payload, every resolution outcome, and delivery
against a real unix socket that records what it received. `cliInputRoutes.test.ts` pins the address
shape, that codex is refused by the pattern rather than at runtime, that a GET never delivers, and
that an undeliverable turn is an answer rather than an error status. `useCliInput.test.tsx` pins the
band choice, that a slow answer for a previous thread cannot enable a composer on the current one,
and that a refused turn keeps its band. The app tests pin the composer swap and that a refused turn
keeps the draft.

Not confirmed on hardware: no turn has been delivered to a live session from a phone.

## Pros and Cons of the Options

### Option A: terminal window plus synthetic keystrokes

- Good, because it would extend to any CLI agent, Codex included.
- Bad, because the parent chain reaches the application, not the window, and the tty-to-window join
  it would need is absent in several terminals and impossible through tmux or ssh.
- Bad, because delivery would require focusing someone else's window.

### Option B: the session's own inbox

- Good, because the address is the session id and the transport is terminal-agnostic.
- Bad, because the protocol is private and gated.

### Option C: Channels

- Good, because it is documented and stable.
- Bad, because it must be opted into at session start, so it cannot reach any session already
  running, which is the entire population.

## Links

- ADR-0091 own live agent sessions behind provider-neutral backends (the window band)
- ADR-0099 observe background tasks from the OS (the registry reader this extends, and the
  discovered-never-supplied rule)
- ADR-0095 relay the agent feed instead of restating it in Swift (why this needed no host change)
