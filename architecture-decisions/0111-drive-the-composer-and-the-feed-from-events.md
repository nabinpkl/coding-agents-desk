---
status: accepted
date: 2026-08-27
---

# Drive the composer and the feed from events, and name the one place that cannot be

## Context and Problem Statement

A thread's transcript stopped updating and nothing said so. Measured on a running host: `mode=raw`,
where every appended line is one event, delivered **1 upsert for 14 appended lines**, then 12 for 12
and 11 for 11 immediately after a module reload. The watcher was still firing. No error reached the
client. It had to be diagnosed from a screenshot of a stalled panel.

That is the cost of a poll, and this codebase had four of them. A poll that returns nothing is
indistinguishable from a system with nothing to report, so a dead subscription, a broken watcher, and
an idle agent all render identically. An event that never arrives is a missing call; a tick that
finds nothing is silence that looks like health.

Investigating it turned up something worse than the freeze. ADR-0110 describes composer text as
event-driven, through an `AXObserver` registered on the composer element. It never fired. The helper
ended in `dispatchMain()`, which parks the main thread on the dispatch queue and never runs a
CFRunLoop, while `AXObserverGetRunLoopSource` is added to `CFRunLoopGetMain()`. Measured with an
isolated probe registering one `NSWorkspace.didLaunchApplicationNotification`: nothing under
`dispatchMain()`, the notification under `CFRunLoopRun()`. Every "event-driven" claim in that path
was describing code that ran and delivered nothing.

## Decision Drivers

- A surface that stops updating must say why, in a log line, not in a screenshot.
- A mechanism described as event-driven must be observed delivering an event.
- Polling that stands in for an event nobody wired should be replaced by the event.
- Polling that stands in for an event the OS does not publish should stay, and say so.

## Considered Options

- **Option A**: Fix the freeze and leave the polls.
- **Option B**: Convert every poll, including the ones no OS event backs, by adding
  EndpointSecurity for process lifecycle.
- **Option C**: Convert every poll an event exists for, keep the one that has none as an explicit
  backstop, and make the silent paths loud.

## Decision Outcome

Chose **Option C**.

`CFRunLoopRun()` replaces `dispatchMain()` in `--control`. It also drains the main dispatch queue, so
it is strictly the more capable of the two and nothing that worked before stops. This single line is
what makes the AX observer real for the first time, and it is a precondition for everything below.

Three polls become events:

- **Live-tail capability.** The live backends announce from `ensureProjection`, the one place a
  session gains a projection. A thread stream subscribes instead of asking every five seconds.
  Probed optionally, the same way `sessionUsage` already is, so `AgentBackend` gains no member and
  Pi implements nothing.
- **Bot store.** `BotStore` watches its own directory rather than the registry rebuilding a full
  snapshot every second per subscriber. The directory and not the file, because `write` lands as a
  temp file plus a `rename` and a watch bound to the old inode sees one change and then nothing.
- **Composer state.** Application launches, terminations, and Desktop switches arrive from
  `NSWorkspace`; the AskUserQuestion panel appearing and disappearing arrives from
  `kAXCreatedNotification` and `kAXUIElementDestroyedNotification` on the application element. The
  helper filters none of it: pid and bundle id go up as they arrive and the sidecar decides what
  matters, because which sessions are interesting is exactly the part that changes without a rebuild.

**The fourth stays, and this is the part worth reading.** A session is resolved through a
`claude --resume <id>` CHILD process, and macOS publishes no notification for an arbitrary process
starting or exiting short of EndpointSecurity, which is its own entitlement and its own TCC grant for
a question `/bin/ps` answers in milliseconds. So `claudeWindowResolveIntervalMs` survives, demoted
from a 3s primary to a 30s backstop. It is not event-driven and the code says so where it lives,
because a reader who believes the poll is gone will not understand why a new terminal session takes
a while to appear.

### Consequences

- Good, because the composer's AX observer delivers for the first time. This also closes a latent
  bug: the poll SKIPS its value read once a pid is observed, so a successful `composer-observe`
  used to stop the text updating by either route.
- Good, because a scan that consumes bytes and emits nothing now logs
  `agent-feed-index-scan-emitted-nothing` with the offsets, and a transcript that cannot be `stat`ed
  raises to the follower instead of returning quietly. The freeze's next occurrence is a grep.
- Good, because composer traffic drops roughly tenfold, and the bot registry stops rebuilding a
  snapshot 86,400 times a day per subscriber for a file that changes a few times.
- Bad, because the freeze itself is **not fixed**. Its first hypothesis -- a drop mid-build letting
  two scans poison one offsets array -- was disproved by its own test: `dropIndexState` clears all
  five maps together, so both builds restart from zero and converge. It did not reproduce at three
  hours of uptime either, so the uptime correlation was two coincidental samples. What landed is the
  instrumentation to catch it and hardening against a real adjacent defect (a build's `finally`
  deleting a successor's entry), not a repair.
- Neutral, because `CFRunLoopRun` returning is now an explicit `exit(0)`. It returns only when every
  source is gone, which for this process means nothing is left to answer with.

### Confirmation

- Isolated probe, one registration, only the main loop differing: `dispatchMain()` delivers nothing,
  `CFRunLoopRun()` delivers the notification.
- Through the real helper after the change: a background `open -g -a Calculator` and its quit
  produced `workspace-changed` `launched` and `terminated` with pid and bundle id.
- The idle watchdog still ends the process on silence under the new loop (measured: exit at 4s with
  `--idle-seconds 3`), so the reaper ADR-0110 depends on is intact.
- 606 sidecar tests and `just check` green, including new cases for the late-arriving mirror, an
  external `bots.json` write, an application launch refreshing resolution, and a question-panel event
  refreshing only the sessions on that pid.

## Links

- ADR-0110 Own the window composers in TypeScript (amended: its event-driven claim was aspirational
  until the run-loop fix here)
- ADR-0109 Own first-party WebView desktop control in TypeScript
- `AGENTS.md` TypeScript-first WebView glue and logging
