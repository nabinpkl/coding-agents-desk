# File length, directory size and imports

Moved out of the root `AGENTS.md` on 2026-10-17 with the text unchanged. The root file still applies.
Read this before splitting a file or adding one to a directory that is near twelve.

## How long a file gets, and how flat a directory gets

Two caps that pull against each other on purpose, because satisfying one alone produces the other's
failure.

**500 lines per file**, for `.ts` and `.tsx` under `packages/AgentPanel/Web/src` and
`agent-feed/sidecar/src`. A file past that has stopped being one idea, and the reader who needs one
of its ideas pays for all of them. Enforced twice: check 5 in `tools/agent-feed-fitness.sh` answers
"is the tree under the cap", and `tools/git-hooks/pre-commit` (installed by `just
git-hooks-install`) asks at the moment the author still has the concepts in their head, which is
the only moment the split is nearly free. The gate is the authority; if the two ever disagree the
hook is the bug.

**12 source files per directory.** A test rides with its source and is not counted separately:
`foo.ts` and `foo.test.ts` are one thing. Past twelve, the directory has stopped being a place and
clusters into sibling subdirectories.

The second cap exists because the first one produces its violation. Measured 2026-09-09, on the day
both trees were brought under the 500-line cap: `features/desktop-viewer/` held **53** source files
flat with no subdirectory, `sidecar/src/http/` **36**, `features/activity-feed/` **26**, `app/`
**24**. Every file was readable and the directory was not. A flat list of fifty hides exactly what a
two-thousand-line file hid, which is where one thing ends and the next begins.

Three numbers, and none of them is a taste call:

- **Twelve is the ceiling**, because this tree's own distribution has a gap there. Its directories
  sit at 53, 36, 26, 24, 20, 17, 16, 15, 13, 13, 12, 12, and then 10 and below. Twelve is where a
  place stops and a pile starts here.
- **Three is the floor, and it is a rule about SPLITTING rather than a property of every
  directory.** When fan-out sends you looking for clusters, a group of one or two is not one: those
  files stay flat and get named for the fact that they belong together, because a subdirectory
  holding two files is a worse index than no subdirectory. It does NOT say a small directory is
  wrong. `features/screen-viewer/` is one file and `src/types/` is one file, and both are a whole
  thing that happens to be small, not the residue of a bad split. So the ceiling is gateable and
  the floor is not: a check that fails every directory under three would fail five that are correct
  as they are.
- **One clustering level below a feature**, and a second needs its reason written beside it.
  `features/activity-feed/data-source/` is the shape. `features/activity-feed/data-source/transport/http/`
  is the failure this bounds: nesting moves the reader's cost from scanning to navigating, and
  navigating is the worse of the two while you still do not know what you are looking for.

**No relative imports, in either tree.** `@/x` is the project's own src and `@repo/x` is the
repository. Both say where a module lives; `../../..` says how far away the reader happens to be
sitting, and the difference is what a file move costs. A relative import breaks when EITHER end
moves, so clustering one directory rewrites every file inside it and every importer of it, and the
move disappears under path arithmetic. Enforced by check 6 of `tools/agent-feed-fitness.sh` and by
`tools/git-hooks/pre-commit`, sharing one expression.

Two details that are easy to get wrong. In Vite the alias keys carry their trailing slash, because
a bare `@` also matches `@agentdesk/agent-feed-wire` and would swallow the wire contract. In
tsconfig, `paths` resolve against the tsconfig's own directory: TypeScript 7 removed `baseUrl`, and
this repo already wrote them without it. Aliased imports carry no extension. Before this landed the
two trees disagreed and nothing could catch it -- the sidecar wrote `.ts` on 652 of 660 relative
imports, the panel on 0 of 770, and both typecheck either way.

**Only fan-out promotes a cluster.** Do not create a directory because a concept feels like it
deserves one. Create it because the flat list went past twelve and three or more of the files
ALREADY THERE are about the same thing. Concepts do not earn directories, counts do, and that is
what keeps the layout from tracking whoever last had an opinion about it.

**A full directory owes a split, and the file arriving is not what you split.** This is the one that
keeps going wrong, and it goes wrong in the way that is hardest to catch: both gates stay green. A
directory sitting at twelve is asked for a thirteenth file, the author looks for a cluster to put
the NEWCOMER in, finds it is one file or two, reads the three-file floor as forbidding that, and
appends the new concept to an existing file instead -- usually one that already does something
adjacent, which is what makes it sound reasonable rather than like giving up. Measured on
`features/bots/` (2026-09-18, sitting at exactly twelve): the proposal was to put a per-Bot geometry
generator into `botSurface.ts`, because that file already decides a Bot's colour. `botSurface.ts` is
262 lines, so the 500-line cap stays green, the directory count stays green, and a new idea is now
hidden inside a file named for a different one. That is the failure both caps exist to prevent,
reached by obeying both of them.

Two sentences close it:

- **Cluster first, then place.** Being at twelve is the signal; the thirteenth file only delivers
  it. The directory owed a split before the newcomer existed, so relieve the DIRECTORY -- promote
  three or more of the files already in it that are about the same thing -- and then put the new
  file flat, where it belongs, with room to spare. `features/bots/` had six about the canvas itself
  (`BotCanvas.tsx`, `BotCanvasStatus.tsx`, `botCanvasPreferences.ts`, `useCanvasZoom.ts`,
  `useMoveAlongStrip.ts`, `useRememberedCanvasScroll.ts`); all six went into `features/bots/canvas/`
  on 2026-09-23, which left six flat and room for the roster files that were waiting on it. Done at
  the moment the split was owed rather than as a refactor of its own, which is the only moment it is
  nearly free: twenty importers, every one of them a one-line path change a typecheck confirms.
- **The floor is asked of the cluster you are PROMOTING, never of the newcomer.** "A new
  subdirectory would hold only two files" is not a finding about the new file, it is a sign the
  clustering question got pointed at the wrong end of the directory. A newcomer that genuinely
  arrives as three or more related files IS a cluster and gets its own subdirectory on the spot;
  one or two files land flat, which is what flat is for.

**The other exit is a subdirectory for the newcomer alone, and no gate catches it.** A
subdirectory's files do not count toward its parent, so pushing the arriving file into one of its
own leaves both caps green while the parent still sits at twelve, still owing its split, with the
next arrival about to ask the same question. It is the same substitution as cramming: relieving the
directory by moving the NEWCOMER instead of clustering what is already in it. Measured on the commit
behind the proposal above, `8db3d9d5` (2026-09-18, "let Bots wear generated faces behind a
remembered switch"): `features/bots/` stood at twelve, and that arc took both exits at once -- it
appended to `botSurface.ts` AND created `features/bots/avatar/`, which holds one source file,
`BotFace.tsx`. A subdirectory holding one file is a worse index than no subdirectory, which is the
three-file floor read in the other direction. Settled on 2026-09-23 by the fix above rather than by
a different one: the canvas files were clustered, and `avatar/` stopped being a subdirectory for one
newcomer when `BotAvatar.tsx` moved in beside `BotFace.tsx` -- the same two files about a Bot's face
that would otherwise both be flat, which is why either answer was defensible and the one-file state
was not.

If no three of the twelve belong together, that is the finding rather than a licence to cram. Say so
and stop: a dozen files with nothing in common is a feature boundary that is wrong, which is a
larger change than the one you were making and the owner's call, not something to settle by hiding a
concept inside an unrelated file.

Gated since 2026-09-09, and gated the same way the 500-line cap was: only after the tree already
satisfied it. Nine directories were over the ceiling that morning and the worst held 36; the gate
landed on the commit that brought the last one under, because a gate that fails the day it lands
teaches everyone to route around it. Check 7 of `tools/agent-feed-fitness.sh` is the authority and
`tools/git-hooks/pre-commit` asks the same at commit time.

How both trees got here is in `docs/tasks/archive/`: `2026-09-09-ts-500-line-cap.md` carries the
concepts each split file divides on, and `2026-09-09-directory-twelve-file-ceiling.md` carries
which directory became which. Read them before re-deciding one of those boundaries, not before an
ordinary change.
