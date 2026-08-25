# Desktop park manifest

Status: design note, not yet an ADR. Promote it to one if and when an all-windows park ships.

## Why this exists at all

Parking is the mechanism behind two features that share one risk. The narrow one already
ships: a codex window is moved to the active Desktop for about a second so its accessibility
tree can be reached, then moved straight back (`CodexWindowComposerWriter.acquireWindows`).
The wide one is speculative: bring *every* window a canvas wants to show onto one Desktop and
leave them there, because a window only renders while it is on the active Space and not
completely occluded.

The narrow case survives without a manifest. It holds the home Space in a local variable for
1.5 seconds and restores in a `defer`. The wide case cannot, for one reason: the park is
durable. Between the first move and the last restore there is a window of minutes or hours
during which the host can crash, be killed, be updated, or simply be quit by a user who has
forgotten what it did to their Desktops. Without a record on disk, that leaves fifteen windows
piled on Desktop 3 and no way to know where any of them came from. The park becomes a one-way
trip.

The manifest is the record. Everything else here follows from making it trustworthy.

## When it is written

**Before the first move, flushed, and only then does any window move.** A manifest written
after the moves describes a state that already happened, which is exactly the state that does
not need describing. If writing fails, the park does not start.

Written atomically (temp file in the same directory, `fsync`, rename). A half-written manifest
is worse than none: it would be parsed, believed, and used to move windows to coordinates that
were never recorded.

## Where it lives

`Config.desktopParkManifestURL`, derived from `Config.applicationSupportDirectory`, which is
already `~/Library/Application Support/<bundle-id>/`. Per the repo's config rule this is a new
`Config` constant, not a path spelled inline. Deriving from the bundle id means the stable host
and the `.dev` host park independently, which matters because both can be running.

Existence is the state flag. A manifest present at launch means the previous park never
finished its restore, so the host restores from it during startup, before it is willing to park
again. Deleted only after every entry has been restored or explicitly abandoned.

## Format

JSON, one object.

```json
{
  "version": 1,
  "parkedAt": 1756100000.0,
  "hostBuild": "445d773",
  "parkSpaceID": 8214,
  "state": "parked",
  "entries": [
    {
      "windowID": 583212,
      "ownerPID": 97531,
      "bundleIdentifier": "com.openai.codex",
      "ownerName": "ChatGPT",
      "title": "ChatGPT",
      "home": { "spaceID": 4102, "displayID": "1-37D8832A", "ordinal": 3 },
      "homeFrame": { "x": 1152, "y": 139, "w": 600, "h": 877 },
      "parkFrame": { "x": 1100, "y": 120, "w": 600, "h": 877 },
      "stairIndex": 0,
      "restored": false
    }
  ]
}
```

### Field by field

`version` — the manifest is read by a build that may not be the build that wrote it (a crash,
then an update, then a launch). An unknown version is abandoned with a log line and the windows
are left where they are, which is recoverable by hand; guessing at an unknown shape is not.

`parkedAt`, `hostBuild` — pure forensics. When a user finds their windows piled up, these
answer "when" and "which build", and `hostBuild` is the same short git sha already surfaced
through `AgentDeskGitSHA`.

`parkSpaceID` — where the pile was put. On recovery it is how the host tells "this window is
still parked" from "the user has already dragged it somewhere themselves", which is the
difference between restoring and overriding a human decision.

`state` — `parking`, `parked`, or `restoring`. Written as `parking` before the first move and
promoted to `parked` once every entry has moved. Finding `parking` on launch means the crash
happened mid-sweep, so an unknown subset moved and every entry has to be verified individually
rather than trusted.

`windowID` — the address, and **not** sufficient identity on its own. See below.

`ownerPID`, `bundleIdentifier`, `ownerName`, `title` — the corroborating identity that makes an
entry verifiable before it is applied. `bundleIdentifier` rather than the executable path
because the path is an implementation detail of where the app is installed.

`home` — reuses `DesktopWindowAssignment` from `packages/WindowPlacement` verbatim: `spaceID`,
`displayID`, `ordinal`. Not a bare space id, and not yabai's space *index*. Space ids are not
stable across a Mission Control rearrangement, which is precisely why ADR-0092 made the
assignment carry a display and an ordinal alongside the id, and a park that outlives a Mission
Control change needs exactly that repair path. Reusing the type also means the restore goes
through the existing Desktop placement authority instead of a second copy of the same logic.

`homeFrame` — global display coordinates, the frame to put back. Recorded because parking
almost always repositions, and because macOS clamps window origins: a probe asked for `x=2400`
on an 1800pt display and got `x=1760`. Restore must therefore *verify* the frame it landed on
rather than assume the move took, and `homeFrame` is what it compares against.

`parkFrame`, `stairIndex` — where the window was put and its position in the staircase. The
staircase exists because occlusion is all or nothing: a window covered 100% stops rendering
entirely, and a window with a single exposed pixel renders at full fidelity. Each parked window
is offset so a strip of it stays clear of the canvas. `stairIndex` is stored rather than
recomputed so a restore, or a re-park after a crash, does not have to reconstruct an ordering
it no longer has the context for.

`restored` — per entry, so a partial restore is resumable. One window whose app has quit must
not strand the other fourteen.

## Identity, and the trap it exists for

`CGWindowID` is not stable and **is reused**. Codex Desktop restarted once during the
measurement session behind this note and its two windows went from `540230`/`573876` to
`583212`/`584335`, with the pid moving `22510` -> `97531`. A manifest that keyed on the window
id alone and was applied after such a restart would move whatever window now holds that id,
which is a stranger's window at a stranger's coordinates.

So an entry is applied only when the live window at that id still corroborates the record:
same `ownerPID`, same `bundleIdentifier`, and same size. Anything less is an **orphan**: log
it, mark it, and leave it alone. A window left in the pile that the user can drag back is a
much smaller failure than a window teleported somewhere it never was.

Title is deliberately excluded from the match. It changes on its own (a codex window is titled
by its thread) and matching on it would orphan entries that are perfectly valid.

## Restore

1. Read and validate the manifest. Unknown `version`, or a parse failure, abandons.
2. Take the current desktop snapshot (`WorkspaceDesktopAudit`).
3. For each unrestored entry, corroborate identity. Orphans are logged and skipped.
4. Skip any window no longer on `parkSpaceID`: the user has already moved it, and their
   placement wins.
5. Move to `home` through the Desktop placement authority, then set `homeFrame`.
6. Re-read the window and confirm both the Space and the frame. Persist `restored: true` only
   on confirmation, so a crash mid-restore resumes rather than double-applying.
7. Delete the manifest when every entry is restored or abandoned.

Step 6 is the one that is easy to skip and expensive to skip. A `move` call returning without
error is not evidence the window moved; the frame clamp above is the standing proof of that.

## What it deliberately does not carry

No z-order, and the reason is availability rather than focus. The tool this repo already drives
does support raising without focusing -- `yabai -m window <id> --raise` -- but it routes through
the scripting addition, which needs SIP partially disabled. Measured on this Mac: `csrutil
status` reports enabled, `/Library/ScriptingAdditions/` is empty, and the call fails with `could
not raise window with id '...' due to an error with the scripting-addition`, leaving both the
stacking order and the frontmost application untouched. Recording a stacking order the restore
has no way to reapply would be a promise the manifest cannot keep.

Nothing here needs it. The staircase depends on *reading* the front-to-back order
(`CGWindowListCopyWindowInfo(.optionOnScreenOnly)`, no private API and no focus) and then
assigning offsets by rank, so exposure is produced by moves alone. The live cost of not owning
z-order is drift: an app that raises its own window reshuffles the stack, and a window whose
offset no longer matches its rank can become fully covered and stop rendering. That is repaired
by re-running the layout, which is another move, not a raise.

No minimized, fullscreen, or tabbed state. A window in any of those is not a park candidate in
the first place, and recording state the park refuses to touch invites a future restore to try
to apply it.

No per-window capture or canvas layout. Those are canvas state and belong wherever the canvas
persists its own; the manifest's single job is getting windows home.

## Where the pile goes

The park does not have to fit the windows on the display, only their exposed strips. macOS
clamps a window to keeping 40pt on screen horizontally and 32pt vertically, and refuses to put
one under the menu bar at all, so the bulk of every parked window hangs off an edge.

The layout that measured clean at twenty windows: split them across the **left and right** edges
(`x = screenWidth - 40` and `x = 40 - windowWidth`), ten per side, laddered **upward** by 24pt
so a deeper rung sits higher than the one in front of it. Every exposed strip is then a top edge
in `y 39..255`, and the visible cost of the whole pile is two 40pt bands at the screen's sides.

Both choices avoid the Dock, which is the one system surface that can wander into a band. The
sides are clear of a centred Dock horizontally; laddering upward keeps the strips clear of its
reveal zone vertically. The bottom edge would give a smaller footprint -- twenty windows fit a
268x32pt corner -- but puts every strip exactly where the Dock appears, and whether a revealed
Dock counts as opaque coverage has not been measured.

## What the tiles cost

Measured on this Mac (1800x1169, WindowServer shared with a running `AgentDeskHost` and two
observer processes, so treat the absolute percentages as contaminated and the deltas as the
result). Twenty windows, one `SCStream` each, cost charged to both the capturing process and
WindowServer.

ScreenCaptureKit **damage-gates a window on the active Space**. Twenty static windows streamed
for eight seconds delivered 0 `.complete` frames and 4714 `.idle` ones, costing 3.5% of a core
in the client and nothing measurable in WindowServer. Genuinely idle tiles are close to free.

Real agent windows are not idle, though. A live Codex window with nobody typing still produced
138 complete frames in eight seconds, about 17fps, from cursor blink alone. Budget for busy.

Twenty busy tiles at 30fps cost, over an animating-but-uncaptured baseline of 21.2% WindowServer
and 6.2% client: **60.3% WindowServer and 19.9% client**. The shape of that cost is worth
knowing -- one stream alone already adds 25 points to WindowServer, and the next nineteen add
only 14 more, so it is dominated by capture being switched on at all rather than by tile count.

Two levers, only one of which works:

- **Frame rate works.** The same twenty tiles at 5fps cost 50.2% WindowServer and 9.9% client.
  A canvas should give the zoomed tile a high rate and everything else a low one.
- **Resolution does not.** Halving the output size measured 57.2% / 22.6%, no better than full
  size and slightly worse in the client, because downscaling adds a step rather than removing
  one.

The result that bears on the park itself: **damage gating does not survive leaving the Desktop.**
The same Codex window, same stream configuration, measured back to back -- on the active Space,
138 complete frames in 8s (17fps); parked one Space away, 243 complete frames (29.6fps, the full
cap) with zero idle frames, of content that is provably not being drawn. Capturing a parked
window costs more than capturing a live one and shows a frozen image for the money. That is a
second, independent reason to bring windows onto the active Space rather than stream them where
they sit.

## Evidence behind the shape

Measured on macOS 25.4, Codex Desktop (`com.openai.codex`), one 1800x1169 display:

- A window on a non-active Space does not render. An AX write landed in the composer and the
  captured pixels did not move for 16.1s; the sibling window, visible at the same instant, took
  the same write and repainted in 0.39s with 57938 pixels changed.
- Bringing it silently to the active Space, no focus change, repainted it in 0.38s.
- An opaque fullscreen window in front stops rendering completely: no paint in 8s.
- Leaving 1px, 4px, or 24px exposed restores it: paint in 0.42s in every case, with no
  measurable quality difference between them. Occlusion is a threshold, not a gradient.
- Two real codex windows in a 16px staircase behind one opaque cover both kept painting; the
  same two under a full-screen cover both went dark.
- Occlusion is computed against the **union** of what is in front, not against any single
  window. Two covers each spanning half the target, neither covering it alone, both left it
  painting individually and put it to sleep together.
- Move order does not impose stacking order: bringing the two windows to a Space as A-then-B
  and then as B-then-A left the same window in front both times, and a frame move never
  reordered anything.
- Offscreen clamps, 1800x1169 display, 600x877 window: pushing right lands at `x=1760` and
  pushing left at `x=-560`, both leaving 40pt on screen; pushing down lands at `y=1137`,
  leaving 32pt; pushing up is refused outright and the window stays fully on screen at `y=39`.
- Twenty windows laddered ten per side at a 24pt step, with an opaque canvas covering
  everything between the two 40pt bands, all reported `NSWindow.occlusionState` visible.
  Widening that canvas to the full screen took all twenty to not-visible, and shrinking it back
  recovered all twenty.

Those last two are why the ladder reads the stacking order rather than assuming or dictating
one. Because occlusion is union-based, a window in the middle of a tightly stepped ladder is
covered by its two neighbours together whenever both happen to be in front of it -- for 600pt
windows stepped by 16, the neighbours' union spans `[16k-16, 16k+616]` and the window itself
only `[16k, 16k+600]`. Offsets have to run monotonically with the real z-order, and since
nothing the park does disturbs that order, one read at park time holds until something external
raises a window.
