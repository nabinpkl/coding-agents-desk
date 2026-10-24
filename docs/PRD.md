# AgentDesk PRD

> Authoritative for **what** AgentDesk is and **why**. How it is built is in [SPEC.md](SPEC.md),
> in this folder. How to work in the repository is in [AGENTS.md](../AGENTS.md), and which
> directories are current is in [FEATURE-MAP.md](../FEATURE-MAP.md), both at the repository root.

## One-line thesis

AgentDesk is a workspace for running coding-agent sessions on your own machines and following them
from anywhere. Each session runs in a tmux pane, and one web panel, open on the Mac or on a phone,
shows what every session is doing and lets you answer it.

## Users

One person, who runs several Claude Code or opencode sessions at once across projects. A Mac is the
main machine, and other macOS or Linux machines can run sessions too. A phone reaches the panel over
Tailscale. AgentDesk does not have accounts or shared use: whoever reaches the panel is treated as
the owner (see [SECURITY.md](../SECURITY.md)). The repository is public so that others can run the
same setup for themselves.

## Problem

- Agent sessions run for a long time in terminals. Following several of them means moving between
  terminal windows, projects and machines, and a session that stops to ask a question waits until
  someone looks at it.
- Away from the desk, a phone cannot follow or steer a terminal session in a usable way.
- The first answer, a native Mac app streaming the screen to a native iPhone app, cost a rebuild and
  a reinstall for every change, and by September 2026 it was no longer the main path. Its design is
  kept in [dormant-native-design.md](dormant-native-design.md).

## Solution

A sidecar process on each machine starts the sessions, reads their transcripts and serves an HTTP
API, and a web panel shows them.

- Sessions run in the agents' own interfaces: Claude Code's terminal UI (or Claude's Agent SDK, for
  a session started that way) and opencode's, each in a tmux pane. The panel is a view and a way to
  type into them. Closing the panel does not stop any session, and every session stays usable
  without the panel.
- The panel groups sessions into Bots. A Bot is a name, a project folder and the sessions working in
  that folder, and the Canvas shows each Bot's sessions as cards.
- The panel and the sidecar are TypeScript that run from source, so a change to either one reaches
  an open panel on the next save, without a rebuild or a reinstall.

## Current user surface

Sessions:

1. Start a Claude Code or opencode session in a project folder, as a Bot's first session, as a new
   session on a Bot, or as a fork of another session. Each one runs in its own tmux pane.
2. Read a session's transcript as it is written, with its tool calls, images and subagents, and jump
   to any point in it without loading everything before that point.
3. Type into a session, paste images into it, answer the questions its agent asks, change its
   permission mode, rewind it and rename it.
4. Hand a session over from Claude Code to opencode, or the other way, as one prompt.
5. Get a push notification when a Bot's session finishes a turn or waits on a question.
6. See the background tasks a session started, how full its context window is, and a summary of a
   turn on request.

Organising:

7. Keep Bots on the Canvas, each with its session cards, and archive sessions that are done. One
   session per machine can be the Father, kept in a floating window over the Canvas.
8. Follow sessions on several machines, and on several macOS login sessions of one Mac, on one
   Canvas, with each Bot and each action staying on the machine it belongs to.

Around the sessions:

9. Open any tmux window or pane on a machine in the Terminals tab, without resizing it.
10. Browse, edit and search a project's files, and read its git status, in the IDE tab.
11. Stream one of the Mac's displays or one window to the browser and drive it with the pointer and
    keyboard, switch between macOS Desktops, and park windows, in the Desktop tab. The Screen tab
    shows the Mac through macOS Screen Sharing, which also works at the login window.
12. Send one prompt to several sessions, each in its own git worktree, and read their answers side
    by side in the Arena tab, with an optional judge session.
13. Exchange messages with agents in the Messages view. Agents can message each other and the owner,
    across machines, through a hub you deploy, and an agent can ask the owner a question that
    appears in the panel and waits for the answer.
14. Read rate-limit meters and a history of token use for each vendor.

## Acceptance

Acceptance is empirical. The owner runs their agent work through AgentDesk every day, and a version
is done when the friction they meet in that use reaches a steady state: a session that cannot be
reached, a card that falls behind its transcript, a phone surface that fights the finger. Each
friction found is fixed, or recorded as a decision in `architecture-decisions/`.

## Non-goals

- **Several users.** AgentDesk does not have accounts, a login or sharing.
- **Reaching the panel from the internet.** The panel listens on loopback by default, and on the
  tailnet when asked.
- **Replacing the agents' own interfaces.** Sessions stay in Claude Code's and opencode's own
  terminal UIs, and AgentDesk does not write into Claude Code's own files.
- **Scoring agents.** The Arena records what each session did and leaves the judging to the reader.
- **Desktop features off macOS.** A second machine can run Linux for its sessions. The Desktop and
  Screen tabs need a Mac.

## Dormant and experimental parts

- **Dormant:** the native iPhone app and the Mac app's video pipeline to it; Codex and Pi as session
  providers; the Feed tab's Sessions and Bots views, replaced by Canvas; voice input, the system
  keyboard and browser projection. Each one is still in the tree, and FEATURE-MAP.md lists what each
  one still touches.
- **Experimental:** spoken announcements of a session's events, and Agent Radio, an audio stream of
  them for a phone.

## Sources of detail

- How it is built: [SPEC.md](SPEC.md).
- Which directories are current: [FEATURE-MAP.md](../FEATURE-MAP.md).
- Decisions, one per record: [architecture-decisions/](../architecture-decisions/).
- The iteration ledger: [TASKS.md](TASKS.md), with retired ledgers in
  [tasks/archive/](tasks/archive/).
- The native apps' requirements and design: [dormant-native-design.md](dormant-native-design.md).
