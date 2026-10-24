# Commit timeline

A single static page that plots this repository's own history: weekly commit volume, then every
commit newest-first, grouped by day, filtered by kind, week or free-text search. Each row expands to
its full message, refs and line counts, with the sha copyable.

```
just commits-timeline          # generate the data and serve it on http://127.0.0.1:4290
just commits-timeline-tailnet  # once per machine: put that port on the tailnet's HTTPS origin
just commits-timeline-stop     # stop the server started above
```

`commits-timeline` prints both origins at startup. `AGENTDESK_COMMITS_PORT` moves the port; nothing
else needs to know it.

## What is committed and what is not

| Path                                                      | Committed | Why                                                                                       |
| --------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------- |
| `public/index.html`, `public/styles.css`, `public/app.js` | yes       | the site itself                                                                           |
| `generate.mjs`, `serve.mjs`, `config.mjs`                 | yes       | the two programs and the one place paths and the port live                                |
| `.build/commits-timeline/data.json`                       | no        | it carries commit authors and messages; the checkout owns those, the public tree does not |

`generate.mjs` writes the data, `serve.mjs` reads it. Serving is loopback only: the tailnet is the
auth boundary, the same way the panel's dev origin works, and `tailscale serve` terminates HTTPS.

## What it reads

`git log --no-merges` for the current checkout, both the message pass and the `--numstat` pass, so
the timeline reflects what is on disk rather than a cached export. Merge commits are left out
because they carry no diff of their own; the branch landings are already in the history they joined.

Each subject's conventional-commit prefix becomes its kind (`feat`, `fix`, `docs`, ...). A prefix
outside the filter row's set keeps its own word in the tag and is counted under `other` for
filtering, so the chips stay countable without relabelling what an author wrote.

Regenerating is a deliberate act: the page never polls. Re-run `just commits-timeline` after new
commits land and reload.

## Why the page is plain HTML, CSS and JS

It has no build step and no dependencies, so it opens from the served directory as-is and nothing in
this repository's JS toolchain has to stay healthy for it to work. The one network request is
`/data.json`.

## Verification

`serve.mjs` re-reads a file when its mtime moves, so an edit plus a reload shows the edit. That is
worth stating because the first version cached by path and served the previous CSS while looking
like it had applied the change.
