# Contributing

AgentDesk is maintained by one person and is in active development (see [README.md](README.md)).
Issues are welcome. A pull request starts with an issue.

## Issues

Open an issue for a bug, a question, or a setup step that did not work. A useful report has:

- the macOS version, and the versions of Bun, Node.js and Claude Code or opencode;
- the commands you ran, and the result you expected from them;
- what happened, with the lines from the sidecar's terminal or the panel's dev server that show it.

Report a security problem privately, as [SECURITY.md](SECURITY.md) describes, rather than in an
issue.

## Pull requests

Open an issue before you write a pull request, so the change can be agreed there first. A pull
request without an agreed issue may be closed. One change per pull request is easiest to review.

Before you open one:

1. Run `just git-hooks-install` once. In the panel's and the sidecar's source trees, its pre-commit
   hook refuses a file past 500 lines, a relative import, a directory of more than twelve source
   files, and a file the formatter would rewrite.
2. Run `just check`, and put the legs it ran and their test counts in the pull request.
3. Follow [AGENTS.md](AGENTS.md) and the notes under [docs/agents/](docs/agents/). They are the
   working rules for everyone changing this code, people and coding agents alike. A decision that
   locks something in gets a record in [architecture-decisions/](architecture-decisions/), started
   from its `TEMPLATE.md`.
4. Keep names, addresses, account ids, device ids and credentials out of the change.
   `just public-scan` checks for credential shapes on any machine.

The maintainer does not promise a response time.

## License

Contributions are accepted under the repository's [MIT License](LICENSE).
