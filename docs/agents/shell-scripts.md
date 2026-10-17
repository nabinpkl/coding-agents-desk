# Shell strings and deletes

Moved out of the root `AGENTS.md` on 2026-10-17 with the text unchanged. The root file still applies.
Read this before building a command string for a shell or tmux, and before writing any delete.

## An argv flattened into a shell string must be quoted per argument

This repo hands commands to shells constantly -- tmux runs its pane command through `/bin/sh -c`,
the PTY manager launches through a login shell, and the helper types lines into a terminal. Every
one of those is the same conversion: a list of arguments becomes ONE string, and the shell then
splits it back into arguments. That split is not the inverse of the join unless each argument was
quoted on the way in.

Measured 2026-09-07, and the failure is worth knowing by shape because it does not look like a
quoting bug. `newSessionArgs` built its script with `command.join(" ")` and quoted only the finished
script. That was correct for as long as every argument was a bare token -- `claude`, `--resume`, a
uuid. The first argument with a space in it was a session title passed to `-n`, and the pane printed
`zsh:1: invalid mode specification` twice and then sat at a shell prompt with no agent running.
Nothing in that message says "quoting": zsh had read the `(fork 1)` in `Session (fork 1)` as a
**glob qualifier**, `f` being the file-mode one, so `ork 1` was an invalid mode. A fork that looked
started and was not.

So:

- **Quote every argument, not the assembled string.** `command.map(shellQuote).join(" ")`. Quoting a
  bare token costs nothing, and is what stops the first non-bare one being a bug.
- **Get the single-quote escape right, and check it in the language you wrote it in.** A
  single-quoted shell string cannot contain a single quote, so each one leaves the quoting, adds an
  escaped quote, and re-enters. Writing that in a JavaScript string needs the backslash escaped;
  it was written with one backslash, which JavaScript reads as three plain single quotes, so the
  helper emitted a string that left the shell inside an unterminated quote. It had never fired
  because nothing user-supplied had gone through it.
- **Test the property, not the spelling.** These strings are read by two shells in turn, so
  asserting how they are quoted asserts nothing about whether the argument arrives. Run the
  hazardous cases through the real shells and check the argv the command receives -- a value with
  parentheses, an apostrophe, a `$`, a backtick, a `;`. That is the test that catches both of the
  above; the exact-string assertion that existed did not, because it was written against the
  arguments that already worked.
- **Prefer not to build a string at all.** Where the interface takes an argv (`Bun.spawn`, the PTY
  manager's `arguments`), pass the argv. The quoting question exists only where something insists
  on one string, which here is tmux and the shells it runs.

## A delete names an absolute path, and preferably one this run created

Every `rm -rf`, `rmSync`, `rmdir` and `shutil.rmtree` in this repo takes an ABSOLUTE path, built
from a root the script resolved for itself. This is preventive rather than a scar: nothing here has
destroyed a home directory. It is written down because it is the one class of bug with no undo, a
script only gets one chance at it, and every ingredient is already present -- these tools run from
`just` recipes, from launchd, from a sourced shell function, and over ssh, so four different
processes with four different working directories run the same lines.

- **Absolute, because a relative path is interpreted against whatever the cwd happens to be.** `rm
  -rf build` means one thing in the repo and another in `$HOME`, and the `cd` that was supposed to
  make it safe is exactly the command that can fail. `tools/runtime-paths.mjs` already holds the
  read-side of this rule -- `absoluteEnvironmentPath` throws when an override is not absolute --
  and a delete deserves at least what a write gets.
- **Guard the variable, not just the command.** `rm -rf "$ROOT/$NAME"` with `ROOT` empty deletes
  `/$NAME`, and with both empty deletes `/`. `set -u` does NOT catch this: an unset variable is an
  error, an EMPTY one is not, and a `$(mktemp -d)` that failed assigns exactly that empty string.
  One line covers it, before the path is used or trapped: `: "${ROOT:?}" "${NAME:?}"`. Quote every
  expansion, for the reason the argv-quoting section above gives at length.
- **Delete what you created, by the name you were given.** Keep the value `mktemp -d` or
  `mkdtempSync` returned and remove exactly that. Never a glob, never its parent, never a path
  reassembled from pieces. A `trap` installed before the variable is assigned fires with an empty
  one, so assign first and trap second.
- **Anything else gets a confinement check first.** A path from configuration, from a wire request,
  or from a caller is checked to be under the root you expect before it is removed, the way
  `workspace/workspaceBrowse.ts` and `bots/botDirectory.ts` do for listing and binding. A path that
  fails the check is a bug to report, never a path to delete anyway.

Deleting anything you did NOT create is a destructive act under the universal rules and wants a
human's go-ahead, whatever this section says about how to spell it.
