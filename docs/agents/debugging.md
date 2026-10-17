# When a probe comes back empty

Moved out of the root `AGENTS.md` on 2026-10-17 with the text unchanged. The root file still applies.
Read this when a check you wrote reports nothing, or a log query returns no lines.

## An absent result is a claim about the probe until a second look agrees

When the check you wrote to verify a change comes back **empty** -- no scrollback, no rows, no
events, zero bytes, nothing matching -- corroborate it a different way before touching the feature
code. An absence is the cheapest thing a broken probe can produce, and it is indistinguishable from
a broken feature by looking at it harder.

Measured 2026-09-06, on the terminal tiles. A DOM probe read `.xterm-viewport.scrollHeight` to ask
whether imported scrollback had landed, and reported `scrollHeight === clientHeight` twice, across
a reload. Wrong element: xterm's DOM renderer sizes that viewport from a spacer that does not track
the buffer, and the history had been there the whole time. Acting on the absence produced a feature
change made for the wrong reason and then a diagnostic tangent into whether tmux puts its client on
the alternate screen, complete with a hand-rolled pty probe. A single screenshot settled it, and the
real defect was somewhere else entirely: captured lines carried LF without CR, so the history was
present but rendered as a staircase.

Second looks that cost almost nothing:

- **A screenshot of the real surface.** The one thing that cannot report an absence that is not
  there.
- **The same question one layer down or up** -- the API instead of the DOM, the log instead of the
  API, the process table instead of the log.
- **The input rather than the output**: did the bytes arrive at all? A network panel showing a 200
  with a body means the feature worked and the probe did not.
- **Ask the human what they see.** They are looking at it.

Two failure shapes this prevents, both of which happened in one evening: changing working code
because the measurement was wrong, and spending the next hour explaining a phenomenon that never
occurred. The second is worse, because every step of it is sound reasoning from a false premise.

The corollary for the other direction: a probe that reports **success** deserves the same suspicion
when it is the only thing that agrees with you. See also the exit-code rule under Commits, which is
the same mistake at a different layer.

### `log show` answers nothing here, so os_log is a live channel and not a record

Measured 2026-09-09, twice in one evening, and it is the absent-result rule above with a specific
face. **`/usr/bin/log show` returns zero lines for EVERY process in this session** -- not just for
debug levels, not just for one subsystem. `log show --last 1m --style compact` with no predicate at
all returned nothing on a plainly busy machine, while `log stream` on the same shell printed
CoreSpotlight traffic immediately. Treat the whole retrospective tool as unavailable.

What that costs, concretely. The host logs every line of the agent-feed sidecar's stdout and stderr
at `.notice` (`AgentFeedSidecarProcess.consumeOutput`), so a `log show` query for that subsystem
returning zero reads as "the host does not keep the sidecar's output". It does keep it. It cannot
be read back from here, which is a different sentence with a different fix, and an hour was spent
on the wrong one.

- **Test the probe against a case that MUST produce output before believing an absence.** One
  unpredicated `log show --last 1m` settles it in seconds, and it is the cheapest second look in
  this file.
- **`log stream` works, and only forward.** Start it, then make the thing happen. It cannot answer
  a question about a failure that already happened.
- **So anything you may need AFTER the fact needs a file.** The sidecar's output is written to
  `/Users/Shared/agentdesk/logs/<user>-agent-feed-sidecar.log`, beside the WebRTC diagnostics log
  and named per user for the same reason (`runtime-paths.mjs`), bounded at 16MB, with a line at
  every spawn so a reader going backwards knows which run they are in.
  `AGENTDESK_AGENT_FEED_SIDECAR_LOG` overrides the path.

One state that used to need noticing by hand no longer does: a `bun --watch` sidecar that threw
during a reload stayed ALIVE with its port free, so every exit-driven restart path missed it. Two
things closed it. The host probes the port rather than the process and restarts after a minute of
silence; and since 2026-09-15 the live arm is a supervisor rather than `--watch`, which never hands
the server a file that will not parse and starts it again if it dies. If a surface goes blank,
`/api/config` answering is still worth checking, but a sidecar sitting dead for half an hour is no
longer the expected shape of that.
