# public-scan

Keeps personal data and credential-shaped strings out of this repository, so it can be published.
It runs on every `just check`, as check 10 of `tools/agent-feed-fitness.sh`.

## Two rule sets

- **`secret-rules.txt`** (checked in): the shapes of credentials no tree should hold, whoever's it
  is: private keys, Anthropic, OpenAI, GitHub, Slack, AWS, Google and Stripe keys, JWTs.
- **The personal denylist** (never checked in): names, addresses, domains, account and device ids,
  tailnet names. It lives outside every checkout, at the path
  `node tools/runtime-paths.mjs public-scan-denylist` prints (override with
  `AGENTDESK_PUBLIC_SCAN_DENYLIST`). Committing it would publish exactly what it guards.
  `denylist.example` shows the format with made-up values.

A machine without a denylist still checks the secret shapes, and prints that it skipped the rest.

Both files take one rule per line: `<id> /<regex>/<flags>`, flags from `imsuv`. Ids are unique
across the two files, and a rule that matches an empty string is refused.

## What is scanned

Every tracked file and every untracked one git does not ignore, because `just check` treats both as
part of the change. For each: its path, its contents, text inside long base64 runs (decoded), and
the printable runs of a binary file. A hit on the path itself is reported as line 0.

## The baseline

`baseline.tsv` records the hits that were already in the tree when the gate began, as
`count<TAB>rule<TAB>path`. The gate fails when a path holds more hits for a rule than the baseline
allows, and also when it holds fewer, so an improvement is recorded and cannot be spent on a new hit
elsewhere. When you remove some:

```
just public-scan --update-baseline
```

and commit the baseline with the change. Never regenerate it to make room for a new hit: take the
string out instead. Rewriting the baseline is refused on a machine without the denylist, because
every personal entry in it would be dropped. Once the tree is clean the baseline is deleted.

## Checking a history

```
just public-scan --history <git rev-list arguments>
```

for example `--history main` or `--history upstream/main..main`. Every blob, path, commit message and
commit identity reachable in that range is checked against both rule sets, and gitleaks is run over
the same commits when it is installed. There is no baseline here: a history about to be published has
to come up empty. It needs the denylist.

gitleaks reads `.gitleaks.toml` at the repository root: its default rules, plus one exception per
value that looks like a secret and is not one (a placeholder key in a test, a checksum, a public
manifest key). Each exception names its file and its exact value, so the same value elsewhere, or a
different value in that file, is still reported. Add one only after reading the line it is on.

## Publishing

`main` reaches the public repository through one command:

```
just publish
```

It sends `main` to the remote that `git config agentdesk.publicRemote` names, and only after
`--history` comes up clean over the commits that remote does not have yet (all of `main` the first
time). It refuses on a machine without the denylist, and refuses anything that is not a
fast-forward of the public `main`. `tools/publish.sh` says what each check is for.

The pre-push hook `tools/git-hooks/pre-push`, linked by `just git-hooks-install`, refuses every
other push to that remote: a plain `git push`, a tag, another branch, a delete, a force-push, or a
commit other than the one `just publish` scanned. It recognises the remote by its name or by its
URL. Pushes to every other remote, `origin` included, pass untouched, and with
`agentdesk.publicRemote` unset every push passes. `git push --no-verify` skips the hook, as it skips
every hook.
