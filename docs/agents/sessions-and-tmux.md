# Sessions, tmux, opencode and probe sessions

Moved out of the root `AGENTS.md` on 2026-10-17 with the text unchanged. The root file still applies.
Read this before starting, renaming, messaging or probing a Claude or opencode session.

## Where sessions run, and where they are watched

The work and the wall are separate, and conflating them wastes an evening. Settled 2026-09-06:

- **Work runs as the console user, in tmux.** `tmux new-session -d -s <name> -c <repo> 'claude
  --resume <transcript-uuid> --fork-session -n "<label>"'` forks the calling session's context into
  a new one running as the console user, on that user's repo, with that user's permissions. Remote
  Control needs no enabling: it is on, and the forked session appears in the app's sidebar by itself.
- **A session off the canvas that goes quiet is closed** (since 2026-10-16, on the owner's word).
  Each sidecar sweeps its own machine a minute after it starts and hourly after that
  (`terminal/session-panes/idleSessionSweep.ts`), and closes the tmux pane of a Claude session
  that is in no Bot on the canvas, is nobody's Father
  session, has had no event for 2h (`AGENT_FEED_IDLE_CLOSE_AFTER_MS`, 0 turns it off), and whose
  own registry says `idle`, re-read just before the close. Only a pane the sidecar stamped, with
  nobody attached, nothing else in it, and the idle Claude process inside it. Opening the session
  again resumes it; the transcript is untouched. To keep a session running, keep it on the canvas.
  An opencode pane is closed by the same rules, with busy asked of the serve
  (`GET /api/session/active`) and nothing closed when the serve cannot be asked. Its TUI is only a
  client, so a close never ends a turn; the gap is a TUI switched to another session in a tab,
  which the stamp cannot see. Each close is a `[idle-sweep]` line in the sidecar's log.
- **The agent session is the viewing wall and runs none of the work.** Its Claude Desktop windows
  hold Remote Control *views* of those sessions. Typing a prompt into one of those windows instead
  starts a session inside the `agent` account, which then fails on its own with `Failed to run Look
  for local project folders`, because that account has no project registered. Measured, not assumed.
- **tmux is the backbone, not the interface.** Reading it is `tmux capture-pane -p -t <session>`.
  Driving it by hand is awkward enough that the desktop view earns its place.

Five traps, each of which cost real time:

- **`tmux send-keys -l` silently drops a long string.** 2600 characters produced an empty composer
  and no error, while a short string on the same channel landed. Chunk at ~300 characters with a
  short sleep between them, then send `Enter` as its own call.
- **Three identifier namespaces name one session and none converts to another.** CCD's
  `local_<uuid>` (what `list_sessions` and the cross-session message tool take), the Claude Code
  transcript uuid (what `--resume` takes, and what the `.jsonl` under `~/.claude/projects/` is named
  for), and the `ListAgents` peer name. One session here was `local_eadabff2…` and `35cf85c7…` at the
  same time. A transcript uuid is never a valid message target.
- **The cross-session message tool cannot reach a tmux CLI session.** It knows only sessions the
  desktop app tracks, and a `claude` started from a shell does not appear in `list_sessions` at all.
  Use tmux for those. `SendMessage` is separately disallowed in some sessions, so `ListAgents` will
  cheerfully list peers that cannot be written to.
- **No message channel can stop a running turn.** Not the cross-session tool, whose own description
  says it is for handing off context rather than orchestrating work, and not `SendMessage`. Escape
  twice in Claude Desktop opens **Rewind**, not a stop. Interrupting is a GUI act, and it is the one
  thing the viewing wall is genuinely required for rather than merely convenient.
- **A session has TWO names.** `-n` sets the **address**: it is written to the session's registry
  file as `name`, and that is what `ListAgents` prints and what `SendMessage` addresses. The
  **title** is a `custom-title` record in the transcript, which is what `/resume` shows, what the
  sidecar reads (`claudeTranscript.ts`, `title = customTitle ?? aiTitle`), and what the Agent Panel
  puts on a session.
- **There are two ways to rename and they do NOT do the same thing.** Measured 2026-09-07 on
  v2.1.263, after `AGENTS.md` said the wrong thing about both:
  - **`/rename <title>`, in the session**, changes BOTH. It writes a `custom-title` record AND an
    `agent-name` record, and updates the running process's registry `name` to the new value with
    `nameSource: "user"` -- so the pane header, `/resume`, the panel, and `ListAgents` all move
    together. It takes the title inline on one line. This is the complete rename.
  - **`/resume` -> Ctrl+R, from another session**, changes only the title. Measured: a session
    started `-n "Rename probe A"` and renamed through the picker kept **Rename probe A** in the
    registry, with `formerNames` untouched. The picker will not offer you the session you are
    sitting in, so a session cannot rename itself this way.
  - **Appending a `custom-title` record from outside** also changes only the title. It is the only
    one of the three that works on a session with no running process, and the Agent Panel
    deliberately does NOT use it: a rename that moves the title and leaves the address behind reads
    as having worked while every other agent still finds the old name.
- **A renamed session stays findable by its old name.** `/rename` appends to the registry's
  `formerNames` with an `until` stamp, and `ListAgents` prints it: after renaming a live peer, its
  row read `Composer session [cfd12b] - says it was Windows canvas until 28s ago`. So renaming a
  session other agents are mid-conversation with does not strand them.
- **The panel renames by running `/rename` in the session's pane, and three measurements make that
  work.** A bracketed paste of `/rename <title>` IS dispatched as a command -- Claude reads pastes
  literally enough to skip the menu a typed `/` opens, but still runs the command, so the rename
  reuses the composer's ordinary paste path rather than a second input mechanism. It runs
  immediately even mid-turn and does not interrupt the turn. And it is refused when the composer
  holds anything, because the only way to type a command into a box is to type it where the reader
  was writing.
- **A title rename is live everywhere that reads transcripts.** Measured: append a `custom-title`
  record and the sidecar's session list answers with the new title on the very next read -- no
  restart, no cache, last record wins. So the panel, the Canvas and `/resume` pick it up at once.
  Cross-session messaging does not, because it addresses by the registry `name`, which only
  `/rename` moves.
- **Appending a title to a RUNNING session is safe, and the live process adopts it.** Measured
  2026-09-07 against a throwaway session mid-turn: the append landed as the last line, all 33 lines
  still parsed, and the session finished that turn and the next. The CLI re-emits its own
  `custom-title` record periodically -- so the obvious worry is that it overwrites yours -- and it
  does not: after the rename its next re-emission carried the NEW title, which means it re-reads
  the title from its own transcript rather than holding the `-n` name it started with. The pane's
  header keeps showing the address, because an append does not touch it -- `/rename` is what moves
  that, and it moves the header with it.
- **Finding out WHICH session did something is a join, not a guess.** Grep the transcripts under
  `~/.claude/projects/<slug>/` for a symbol or phrase to get a transcript uuid, then map that uuid to
  a peer through `~/.claude/sessions/<pid>.json`, which carries `sessionId`, `name`, `nameSource`,
  `tmux` and `messagingSocketPath` -- and that socket path is verbatim the `from=` on an incoming
  cross-session message. Attribute by that join and never by who created the file: on 2026-09-07 a
  peer inferred authorship from file ownership, and sent a handoff about work in `BotCanvas.tsx` to
  the session that owned the file rather than the one that had written the change.
  - **What produces the wrong guess is ADJACENCY, and it wears more than one costume.** On the
    night of 2026-09-08 three sessions each misattributed the same staged rename within an hour,
    from three different inputs: two from PATH adjacency, because `git status` sorts by path so a
    peer's files and yours interleave by directory and read as one arc, and one from
    CONVERSATIONAL recency, because the peer who last messaged you is the one in front of you. A
    fourth instance in the same hour was about a tmux pane rather than a file -- "that is your
    session's pane", said of a pane that was merely the next card along on a canvas -- which is the
    same substitution of proximity for ownership with no file involved at all. Every one of those
    sessions had this bullet in context. So it is not three mistakes, it is one missing step in
    three places, and the step is cheap: the join below is a grep. Spend it at the moment the
    question comes up, which is while reading `git status` or an incoming message, not afterwards
    when a handoff has already gone to the wrong session.
- **A fork inherits BOTH names verbatim, and the CLI adds no suffix of its own.** Measured
  2026-09-07: `claude --resume <id> --fork-session` with no `-n` produced a session whose registry
  `name` and transcript `customTitle` were byte-identical to its source's. So the `(fork 3)` that
  three sessions here share is not a counter that failed to increment -- it is a name somebody
  typed once, inherited unchanged by every fork since. There is nothing to double up on, which is
  why the panel passes its own `-n "<title> (fork n)"`.
- **Name forks distinctly, because discovery is by name.** Six live sessions here were all called
  "Windows canvas", which makes the bare name address none of them and forces a `[ref]` on every
  send -- and refs are ephemeral, resolvable only from a listing you just read. `-n` is the whole
  fix and it sets both names at once, so a fork started without one is indistinguishable from its
  parent in `ListAgents` from the moment it exists.
- **`--session-id` is accepted alongside `--fork-session`**, and the fork's transcript lands at
  exactly that uuid (measured 2026-09-07 with a chosen id, confirmed in the registry before the
  first turn and in the file name after it). That is what lets the panel name a fork's pane and its
  transcript the same thing rather than discovering the file afterwards.

## The opencode serve is one per machine, and its plugins load hot

Settled 2026-09-26, after a probe's second serve shared the live one's database.

- **Never start a second `opencode serve` on this machine.** Every process shares one global
  SQLite database (`~/.local/share/opencode/opencode.db`), and a second writer dies with
  `SQLiteError: locking protocol` / `database is locked`, sometimes taking the live serve with
  it (upstream issues #15188, #33320, #36775). A different port isolates nothing. One-shot
  probes isolate with a throwaway data dir instead:
  `XDG_DATA_HOME="$d/share" XDG_STATE_HOME="$d/state" opencode run "prompt"`.
- **Plugins load hot; no restart is needed.** The serve watches the global plugin dir and
  per-session project dirs: a new or edited file logs `loading plugin` plus `watcher
  subscribe` and runs setup within seconds, with sessions untouched. Read failures the same
  way, in `~/.local/share/opencode/log/opencode.log` (`role=server`): `failed to load plugin`
  names the file and the cause. The old hooks-object shape (`export const X = async () =>
  ({ "chat.message": ... })`) is dead on this binary -- it imports the file and never calls
  the export, with only `Missing key "default"` in the log to say so. The working shape is
  `export default Plugin.define({ id, setup })` from `@opencode/plugin`, and a global loose
  file resolves bare imports from `~/.config/opencode/node_modules` only.
- **The pre-turn hook is `ctx.session.hook("prompt", ...)`, and it must not loop.** Measured:
  it fires exactly once per admitted prompt, for `queue` and `steer` alike, carrying
  `sessionID`, `messageID`, `delivery` and the mutable `prompt`. The loop guard is structural:
  the hook reads (files, sidecar HTTP) and mutates the admitted prompt in place, and never
  calls `session.prompt`, `generate` or `command` -- those re-enter the hook, which is the
  infinite-LLM-call shape. Keep a per-process seen-set of `messageID`s so a retried hook
  still injects once, never throw, and never instruct the model to emit another user message
  (`set_task` is a tool call, not a message, so it cannot re-fire). A global hook sees EVERY
  session on the machine -- during the probe it caught a foreign `steer` -- so scope any
  injection to Bot sessions before writing a word.

## A session you spin up to PROBE is a throwaway, and the machinery is checked in

`tools/throwaway-session.sh start|say|pane|stop <name>` is how you get a real Claude session to
verify against. Written 2026-09-14, after three sessions in one evening each hand-rolled the same
thing and each rediscovered the same traps.

    id=$(tools/throwaway-session.sh start probe)     # prints the session uuid
    tools/throwaway-session.sh say probe 'Reply with exactly the word: alder'
    tools/throwaway-session.sh say probe /compact
    tools/throwaway-session.sh pane probe
    tools/throwaway-session.sh stop probe

**`THROWAWAY_PROXY=off` starts it around proxy-agent**, so the live mirror never sees its traffic
and the panel has only the transcript and the pane: what a turn looks like when the capture drops
mid-response, and how the question-from-the-pane fallback was verified on 2026-10-14.

**`THROWAWAY_PLUGIN_DIRS=<dir>:<dir>` loads plugins for that session only**, one `--plugin-dir`
each, which is how a probe tries a mod without installing it or writing under `~/.claude`.

**`THROWAWAY_MCP_CONFIG=<file>` gives it MCP servers.** The session runs with
`--strict-mcp-config`, so it has none otherwise, not even the repo's `.mcp.json`; a probe that
sends or answers hub messages names the relay there. Run two such probes from two directories
(`THROWAWAY_DIR`): a directory is bound to at most one Bot, and the repo's is the owner's.
Joining a Bot renames the probe's tmux session to its anchor name (`hubA` became `elias-huba`), so
`say`, `pane` and `stop` take the new name after that.

**`THROWAWAY_STRICT_MCP=off` lets a mod's own MCP server load.** Strict mode hides the servers a
`--plugin-dir` mod brings (measured 2026-10-21, Claude Code 2.1.306). Off, the probe also loads the
user's and the repo's servers and runs the user's hooks, so expect a startup hook to send it off on
an errand before your prompt; the claude.ai connectors are turned off for the session, because their
tools alone overflowed Haiku's 200K context. A mod's tool is named
`mcp__plugin_<mod>_<server>__<tool>` (measured 2026-10-22), and **`THROWAWAY_ALLOWED_TOOLS`** takes
that name to call it without a permission prompt hanging the pane.

**Probe on the cheap model.** The default is Haiku at `--effort low`, and the reason is not
frugality for its own sake: a probe session exists to produce transcript records and API flows, and
nothing reads what it says. The run that prompted this script spent Opus on the word "acorn", three
times. Override with `THROWAWAY_MODEL` when the probe is genuinely about a model's behaviour.

Four things the script does that a hand-rolled one keeps not doing:

- **The session id is CHOSEN, with `--session-id`, and printed.** Otherwise you find the transcript
  afterwards by grepping `~/.claude/projects/` for the title you passed, which races every other
  session starting in the same second. Three namespaces name one session and none converts to
  another -- see the trap above -- so being handed the transcript uuid up front is most of the job.
- **No tools, via `--tools ""`.** A script cannot answer a permission question: the prompt
  appears in the pane and the probe hangs there until somebody looks. This is not sandboxing, it is
  a session with nothing to ask about. `THROWAWAY_TOOLS='Read,Bash'` names the ones a probe needs,
  and then answering the pane is yours. An allow list, because the deny list it replaced went stale:
  asked to say one word, a probe called a tool the list had never heard of. `--tools ""` does not
  reach the Claude in Chrome integration, so the script also passes `--no-chrome`: on 2026-10-16 a
  probe with no tools answered its first message with `read_page` on the owner's browser.
- **`say` chunks the text.** `tmux send-keys -l` drops a long string silently, which is already
  written down under "Where sessions run"; this is where it is implemented, once.
- **Ready means the session has registered, not that the pane drew a prompt.** Its record under
  `~/.claude/sessions` names the chosen id; the prompt character appears while plugins are still
  loading. Not the transcript either: since 2026-10-05 the CLI writes none until the first prompt,
  and waiting for it timed out every start while the session sat ready. Measured on this repo:
  registered in about two seconds, 50k of context from the project's own `CLAUDE.md`, which is
  also why the default cwd is the repo -- a probe about compaction needs a context worth
  compacting.

It runs as the console user in tmux like everything else here, and it is a probe rather than a
worker: give it no job that matters, and stop it when you are done.
