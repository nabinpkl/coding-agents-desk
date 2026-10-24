# Several sessions share one branch

Moved out of the root `AGENTS.md` on 2026-10-17 with the text unchanged. The root file still applies.
Read this before committing in a tree other sessions are editing, which is always.

## Several sessions share one branch, so re-read before you trust anything

Work here is not serialised. More than one session can be on `main` in this single worktree at the
same time, committing and pushing independently. That is the point of the wall rather than an
accident, and it means the repository is a shared mutable surface, not a snapshot you were handed.

**The first act of every turn is finding out what moved since you last looked.** Not courtesy, a
correctness step, before planning and before editing:

```
git status --short && git log --oneline -5
```

Then re-read any file you are about to change. Your in-context copy may predate someone else's edit
to it, and the edit will not announce itself.

What this actually breaks, observed rather than imagined:

- **A green gate is not necessarily yours.** `just check` runs against the working tree, so another
  session's in-flight edits are inside your result. On 2026-09-06 `agent-panel-web-check` went red
  on a `KeyboardDeck` test belonging to a different session mid-arc, in the middle of an unrelated
  commit. When a leg fails on files your diff never touched, read `git status` before you debug it:
  identifying whose they are is faster than diagnosing someone else's half-written test.
- **Commit by PATHSPEC, not by index: `git commit -- <paths>`.** Staging by path is necessary and
  not sufficient, because the index is shared too. A commit takes the WHOLE index, so a peer who has
  already staged something -- and `git status` says so, with an `R` or `M` in the FIRST column --
  puts it in your commit no matter how carefully you added only your own files. Measured 2026-09-08:
  a peer's `forkTitle.ts -> sessionTitles.ts` rename sat staged while this session added six
  unrelated files, and `git diff --cached --stat` showed all eight. Naming the paths on `git commit`
  itself commits the working-tree copy of exactly those, leaves every other index entry staged, and
  needs no `git reset` to arrange. Check `git diff --cached --stat` before every commit anyway: it
  is the only view that shows what would actually land.
  - The nuance that comes with it: a pathspec commit takes the WORKING TREE version of those paths,
    ignoring anything you staged for them. If you staged part of a file and then kept editing it,
    the whole current file is what lands.
  - **And a pathspec is not enough when the peer is inside the same FILE.** That is the case that
    produced `d737b46f` below: the paths named were this session's own, and one of them was a file
    a peer was mid-edit in, so their three functions came along with it. A pathspec bounds which
    files land, never which HUNKS. So before naming a shared hub -- `AGENTS.md`, `wire/index.ts`,
    a barrel, a route table -- read `git diff -- <that file>` and check every added line is yours.
    Where it is not, build that one index entry by hand rather than reaching for `git add -p`,
    which is blocked here: take `git show HEAD:<path>`, apply only your own change to it, hash it
    with `git hash-object -w --stdin`, point the index at it with
    `git update-index --cacheinfo 100644,<blob>,<path>`, and commit the INDEX (no pathspec, which
    would go back to the working tree and undo the whole exercise). The peer's line stays in the
    worktree for them. Done this way on 2026-09-08 for a `wire/index.ts` holding one line of each.
  - **Committing the INDEX reopens exactly what the pathspec closed, so verify AFTER, not before.**
    That is the gap in the bullet above: a hand-built entry can only be committed by index, and an
    index commit takes whatever is staged at the instant it runs. Measured 2026-09-14, doing it by
    the book: `git diff --cached --name-only` listed the thirteen files intended, and the commit a
    few seconds later landed seventeen, having swept up four `workspace-ide/history/` renames a peer
    staged in between. Checking harder beforehand does not help -- the window is however long you
    take between the check and the commit, and it cannot be closed from here.
    - So **read `git show --stat --name-only HEAD` before pushing**, every time you commit by
      index. That check is not racy, because the commit already happened, and a commit that is
      still local is free to unwind.
    - The unwind: `git reset --soft HEAD~1`, then `git restore --staged` the paths that were not
      yours (both halves of a rename), then commit again. Their WORKTREE is untouched by any of
      that, which is what makes it safe; what they lose is the staging, and they have to `git add`
      it back. Say so rather than leaving them to find it.
    - Narrow the window while you are at it: build and stage the hand-made entries LAST, with the
      commit as the next command. Everything else can be staged minutes earlier without cost.
  - `git add -A` and `git commit -a` remain out of the question for the older reason: they sweep up
    whoever is mid-edit in the worktree as well.
  - This is not hypothetical in either direction. On the same night, commit `d737b46f` swept up THIS
    session's uncommitted `tmuxSessions.ts` and landed three unrelated exports under a message about
    composer cursor reading. The code survived; the history is now wrong about who added what and
    why, and that is not fixable on a shared branch without a rewrite nobody should do.
- **Never `git checkout --` a file you did not change.** That is not a revert, it is destroying
  another session's uncommitted work with no undo.
- **A clean tree can go dirty between two of your own commands.** A `git status` read at the start
  of a turn is evidence about that instant and nothing afterwards.
- **`git log` may have moved under you too.** Commits appear on `main` that you did not make, so a
  sha you noted earlier is not still `HEAD`.

The failure mode this prevents is not a merge conflict, which is loud. It is acting confidently on a
stale premise: editing around code that changed, reporting a gate result that measured someone
else's work, or reverting a file that was never yours.
