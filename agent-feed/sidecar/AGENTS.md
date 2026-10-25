# Sidecar: how to work in `agent-feed/sidecar`

The repository root `AGENTS.md` still applies here. This file holds what matters only once you are
changing the sidecar. Moved out of the root `AGENTS.md` on 2026-10-17 with the text unchanged.
How the sidecar is launched and supervised on this Mac: `docs/agents/dev-loop.md`.

## TypeScript-first glue and logging

- First-party interaction glue, iteration policy, and surface-authored diagnostics live in
  TypeScript and the live sidecar by default. Swift remains the thin platform shell for lifecycle,
  the authenticated relay, security boundaries, and OS capabilities that JavaScript cannot own. The
  target is **zero recompilation, zero reinstall, zero relaunch**.
- Reuse the existing `AgentHttpTransport` telemetry path before adding a native log bridge. The
  desktop viewer posts bounded events to `/api/park/tile/:windowID/webrtc/telemetry`; the sidecar
  validates an explicit phase allowlist and appends them to `/tmp/agentdesk-webrtc-diag.log`. This
  works from an already-running surface and updates live with the working tree.
- A proposed Swift change for glue or diagnostics must name the native capability TypeScript cannot
  provide. If there is none, keep it in TypeScript so verification does not acquire a build
  checkpoint.
- **Load timing and traces are Sentry's SDKs, kept on this machine** (2026-10-14). The panel
  (`features/telemetry/`) and the sidecar (`telemetry/`) record page loads, Web Vitals, each
  stream's first message, the panel's milestones, and the sidecar's handling of every request a
  load made, as one trace. They keep errors too: the sidecar's uncaught ones, and every error the
  panel's React roots see, including the ones `PanelErrorBoundary` catches (`panelRootOptions`).
  What they cannot keep is a panel that never started -- a missing import fails before any of
  its code runs -- and that is in the dev server's log instead. Nothing goes to Sentry: the DSN
  is a placeholder on `telemetry.invalid`
  and both SDKs deliver to the sidecar, which keeps every envelope in a 1GB-capped archive
  (`runtime-paths.mjs telemetry-archive`) and copies it to Spotlight if one is running.
  `node tools/telemetry-replay.mjs list|trace|replay` searches the archive and sends an old trace
  back into Spotlight. `npx @spotlightjs/spotlight` is the viewer, and it listens on EVERY
  interface with no option to narrow it, so run it by hand rather than leaving it up.

## A channel that is turned off without being awaited will race its own re-opening

Settled 2026-09-08, on the tmux terminal tiles, and the shape recurs anywhere a resource is
exclusive: ONE pipe per tmux pane, one pty per session, one encoder per display, one listener per
port.

`pipeTmuxPane` returned a `stop` that fired `tmux pipe-pane -t <session>` and returned immediately
-- `void tmux([...])`, not awaited. A viewer leaving and one arriving straight after is not an
exotic case here: it is a card being toggled, a reader moving between two cards on one session, a
Vite reload. Those two issue an off and an on for the same pane with nothing ordering them, and the
off wins about as often as it loses. Measured during a burst of opening and closing: `pane_pipe`
read **0 with three viewers attached**, and **1 with none**.

The failure is silent and looks like something else entirely. A terminal with no pipe still opens,
still imports its scrollback through `capture-pane`, still shows a full screen -- and then never
changes again. Every probe aimed at it finds a healthy layer: the session is alive, the pane has
content, `send-keys` lands, the SSE stream is connected. It reads as a hung agent, not as a lost
pipe. The one-line check that settles it is `tmux display -p -t <session> '#{pane_pipe}'`, and the
rule it stands for is: **when a surface stops updating, ask whether its channel is still open before
reading the code that writes to it.**

So a teardown for an exclusive resource RESOLVES when the far end has been told, and whoever
re-opens waits behind it (`TmuxAttachments.closing`). Releasing is called from a viewer detaching,
which cannot block, so the promise is recorded rather than awaited there; `open` is what waits.

The same debugging pass turned up its mirror image, worth knowing because it is invisible in review:
**an `async` IIFE that finishes without ever awaiting runs its own `finally` BEFORE the assignment
that stores it.** The resize applier cleared its in-flight latch inside itself; an applier whose
every iteration hit the already-there branch completed synchronously, the clear ran first, and the
assignment then latched a settled promise that nothing would ever clear again. Measured on three
live cards: each reached a size, took one report that matched it, and ignored every ask after that,
sitting six or seven columns short of its box for good. Clear a latch from OUTSIDE the promise
(`void applier.finally(...)`), where the callback is guaranteed to run after the assignment -- and
swallow that branch's rejection separately, or a failed call becomes an unhandled rejection as well
as a logged one.

### And under Bun, a watch you close poisons the NEXT watch on that path

Settled 2026-09-10, and it is the rule above failing in the one way ordering cannot fix. **Every
second `fs.watch` on a path is inert.** Measured with six open/close cycles on one file: Bun 1.3.13
delivered `3, 0, 3, 0, 3, 0` events, Node 26.7.0 delivered `3, 3, 3, 3, 3, 3` for the same script.
It reproduces on raw `node:fs.watch` with no chokidar in it, so it is not chokidar's, and
chokidar's own `unwatch` then `add` alternates identically -- there is no escape except never to
take the path off.

Waiting for the close to finish does NOT help, which is the trap: the close resolves, the guard
that was supposed to order them is satisfied, and the watch that opens next is still dead. Nor
does a gap; it is parity, not timing, and a two-second wait fails exactly as a zero-second one
does.

What it cost: `agent-feed/sidecar` opened one chokidar per followed transcript and closed it with
the last reader, so every second visit to a thread got a dead watch. A card toggled, a reader
moving between two cards on one session, a Vite reload -- each is a close and an open on one path.
The live mirror kept streaming, so the thread looked alive while the file it previews sat still,
and the durable rows appeared only when an unrelated reader opened the same session and forced a
scan. Measured on one session: 320s, 124s and 33s of silence inside ten minutes while the file grew
throughout. Every probe aimed at it found a healthy layer, including a standalone chokidar watch on
the same path in another process, which fired perfectly -- it was the first watch in ITS process.

The answer was one watcher for the process with paths added once and never removed. Two details
that bit on the way there: `chokidar.watch([])` never reaches `ready`, so a watcher created bare
and filled by `add` hangs rather than watching; and 500 watched paths cost no measurable RSS, so
never closing was not the expensive half of it.

#### And then the per-file watches went minutes late anyway, so the index stopped watching

Settled 2026-09-15, from a report that a message sent to a session sometimes never appeared in the
panel. Measured with a throwaway session and 20 sent messages, watching four things at once: the
file on disk, the sidecar's timeline stream, a standalone Bun watcher on the same file, and two
freshly started sidecars built from the same source.

The transcript is never the late half. A `queue-operation` enqueue and the `user` record for the
same message are 30 to 700ms apart across 14 sampled turns, whether the session was idle or
mid-turn. What was late was delivery: 1s, 6s, 16s, 26s, 31s, 51s, 62s, 71s, 77s, 93s, 103s, 123s,
202s, arriving in bursts.

Four measurements place the fault, and none of them is the filesystem. A standalone Bun process
running the same chokidar 5 and a raw `node:fs.watch` on that same transcript fired within one
second on every write throughout. A freshly started sidecar delivered in 1 to 2 seconds every time,
and so did a fresh one started under `bun --watch`, so `--watch` itself is not it. The decisive one
is inside the one degraded process: at the same instants, its catalog watch -- the single recursive
`fs.watch` on `~/.claude/projects` from `watchTree` -- reported `lastEventAt` for the same session
within 3 seconds each time, to the same millisecond value a fresh sidecar reported, while its own
per-file watch on that transcript was 35s and 71s late for those same two writes.

So one recursive watch per corpus stays healthy in a long-lived process where hundreds of per-file
watches do not, and **a transcript follow watches nothing**. The catalog's corpus watches
publish every write through `transcriptWrites.ts`, and `followTranscript` routes it to whoever is
reading that file. (The event index this section was written about is gone too: since 2026-10-04 a
transcript row is named by the byte its line starts at and read from there, ADR-0124.) What this does NOT cover, and what would need a stat of each followed file on a
timer rather than a second watcher: a corpus watch that dies leaves a followed transcript sitting
still with only a line in the catalog's log to say so.

Two things hid all of this for weeks. The panel backfilled a hole once a later row exposed it
(then `useTimelineGapFill`; since 2026-10-06 a gap row that fills as the reader reaches it,
ADR-0125), so a row that was 90 seconds late usually arrived alongside the reply and read as
normal. And a sidecar that has just reloaded is prompt, so it worked right after every edit
and rotted from there.

## A test waits for what it expects, never for a length of time

Settled 2026-10-19. The lint gate (`.oxlintrc.json`, check 8 of `tools/agent-feed-fitness.sh`)
refuses `setTimeout`, `setInterval` and `Bun.sleep` in any sidecar test, test harness or fixture;
`src/testing/until.ts` is the one place allowed a timer. A comment or string naming one is fine.

A fixed wait is a guess about how fast the machine is, and it loses on a busy one. Measured that
day: run beside the panel's suite, two tests that waited 10ms for the Bot registry failed; under
`bun test --parallel` a different test failed on each run; and 107 of the suite's 2,284 tests took
37 of its 45 seconds, most of them sitting out timers. With the waits gone the suite ran in 23s, and
`bun run test` now runs it as `bun test --parallel` in 13 to 22s: each file in a worker process of its
own, isolated, so a test cannot lean on what another file left behind.

- **Something will happen**: `await until(() => condition, "what you are waiting for")`. It polls,
  returns as soon as the condition holds, and fails naming what never came.
- **In-memory work is over**: `await drained()`, the next pass of the event loop. An order, not a
  length of time, and it works on fake time too.
- **Nothing will happen**: wait for something that comes after it instead. A marker change on the
  same ordered channel (a second emission, a later message on the stream, a file beside the
  watched one), or the code's own handling of the input finishing. Waiting a while and finding
  nothing is a statement about the wait.
- **The code under test owns the timer** (a debounce, a poll, a timeout): `jest.useFakeTimers()`,
  then `jest.advanceTimersByTime(...)` or `settleOnFakeTime(work, step)`. Reset with
  `jest.useRealTimers()` in an `afterEach`. Two traps on fake time: Bun's own limit for a test is a
  timer and stops too, so switch back to real time before awaiting anything that might never come;
  and `expect(promise).rejects` waits for the promise on the spot, so catch it with `.then` instead
  when the clock has to move first.

## Reach for an event first, and a poll last

Recorded 2026-09-25, on the owner's word, after a Bot's git count shipped as a ten-second poll.

**The first design for anything that has to notice a change is an event, and a timer is the fallback
you justify.** A poll does its work whether or not anything moved, is late by up to its interval
when something did, and multiplies by every reader that runs one. It also hides as convenience:
"asking git every few seconds is cheap" was true of one Bot and was the design for every Bot on
every machine. Ask first whether something already knows when the thing changes -- a filesystem
watch, a stream the sidecar already publishes, the process that made the change -- and subscribe to
that. Poll only when nothing can tell you, and write down beside the timer why nothing could.

**An event source still costs something, and this repo has paid for watches four times**: a
chokidar walk that starved the event loop for 54 seconds (the note above `CHANGE_DEBOUNCE_MS` in
`workspace/workspaceService.ts`), ~2,000 descriptors of per-file watches and the deadlock that came
with them (`transcripts/catalog/watchTree.ts`), and, in the section above, Bun poisoning the next
watch on a path you closed and per-file watches going minutes late in a long-lived process. So "use an
event" means one of the shapes that survived those, not a new watch per thing:

- **One watch per root, shared by every reader of it.** `workspace/repositoryWatch.ts` is the
  reference: one watch per repository whether an IDE workspace, a Bot, or both read it.
- **Watch the platform's cheap way, which is not the same way on both.** Measured 2026-09-25 under
  Bun: on macOS one recursive watch (FSEvents) is 3 descriptors in 2ms for a whole repository, and
  355 one-directory watches are 356 descriptors that `close()` never gives back. On Linux one
  recursive watch walks the tree on the main thread -- 5.1s and 9,104 inotify watches for `rags`,
  build output included -- and 300 one-directory watches are 9ms on one inotify instance.
  `workspace/repositoryEvents.ts` carries both and picks by platform.
- **Filter by what can matter before doing any work.** A change that cannot move the answer should
  cost a string comparison: the repository watch asks `git ls-files` which paths git could report
  on, and on the Linux peer that was 37 of `rags`' 9,104 directories.
- **Do the expensive read only while someone is subscribed**, after a quiet moment, one at a time.
  VS Code's git extension waits for its window to have focus; the panel drops its subscription while
  its page is hidden, which is the same idea.
- **Never close a watch in the Bun process on macOS**, for the reason above and a worse one: a
  `close()` can park the main thread on a lock the File Watcher thread is parked on, and the process
  runs nothing again, timers included (sampled 2026-10-19 in about one test run in 400; see
  `BotStore`'s `watcher`). Keep it for the life of the process and ignore its events instead. That
  ruled out chokidar, which holds a watch per file and closes it when the file goes -- a close you
  never wrote. The lint gate (`.oxlintrc.json`) refuses an import of it in the sidecar; watch with
  `watchTree` or `repositoryEvents`.
