// Multi-source watcher. The sidecar owns one global session map keyed by
// sessionId; each entry carries a `source` tag so its parser is looked up via
// `adapters/index.ts` without source-branching here.
//
// Architecture: discovery (per-adapter chokidar watcher on the source's
// transcript tree) → per-file tail watcher (one chokidar watcher on the
// specific transcript path) → drain (read new bytes since `session.knownSize`,
// hand each line to the adapter, fan out activity events, fold the per-line
// turn-boundary signal into `session.lastTurnClosed`, fire a notification
// when a drain observes a turn closing).
//
// Liveness is never stored here. `lastTurnClosed` + `lastEventAt` are plain
// parse outputs; the 'live'/'ready'/'paused'/'cold' bin is derived at read
// time (digest.computeBin), so a harness that dies mid-turn ages out of
// 'live' by wall clock — no stale-working sweeps, no boot-time status
// reconciliation.
//
// Live tailing begins only after the boot reconcile reaches `live`.

import chokidar from 'chokidar';
import { stat, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { config } from '../config.ts';
import { state, type TailWatcherEntry, type WatcherState } from './transcriptState.ts';
import { emitParsed, resetIndex } from './eventIndex.ts';
import { adapters, adapterFor } from './sources/sourceAdapters.ts';
import { readGitBranch } from './sources/codexTranscript.ts';
import type { Session, SourceAdapter } from './sources/transcriptTypes.ts';

export type { WatcherState } from './transcriptState.ts';
export type { Session } from './sources/transcriptTypes.ts';

const CACHE_PATH = join(config.stateDirectory, 'watcher-cache.json');
// Bumped to 8: `session.status` replaced by `lastTurnClosed` (liveness is now
// derived at read time). Dropping the v7 cache forces one boot probe so every
// session decodes with the new shape; no migration path by design.
const CACHE_VERSION = 8;
const CACHE_SAVE_DEBOUNCE_MS = 5000;
// Cold-boot head + tail probe window. For files larger than this the boot
// reconcile samples just the head (for title / firstPrompt) and the tail
// (for status / lastSnippet / lastUserPrompt) instead of scanning end-to-end.
// Middle-of-file events are reached lazily by `buildIndexFromDisk` on first
// Agent Panel read.
const COLD_PROBE_BYTES = 64 * 1024;

// Per-file watcher inactivity grace period. After this much quiet, the tail
// watcher detaches and the fd is released. Re-attaches on the next
// discovery event (Tier 2 dir watcher) if the file is appended to again.
const TAIL_GRACE_MS = 60_000;
// Coalesce flurries of fs.watch events for the same file before reading.
// Tens of ms is enough to bundle a burst without adding perceptible latency.
const TAIL_DEBOUNCE_MS = 30;
// Hard cap on one drain pass; if the file grew more than this we read in
// successive passes so a single drain never holds the loop for too long.
const DRAIN_CHUNK_BYTES = 4 * 1024 * 1024;
// Safety belt: every minute the sidecar re-enumerates session files via each
// adapter's rescan (catches files missed by the live chokidar watcher),
// re-stats every known session, and reconciles any file whose size differs
// from `knownSize`. Growth drains appended bytes; shrinkage resets and
// rebuilds the transcript cursor and lazy event index. Adapter rescans are
// cheap (one SQLite query for Codex, one
// readdir per slug for Claude) so a 60s cadence is comfortably affordable
// and keeps missed-file recovery near-realtime.
const SAFETY_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 60_000;

export function getWatcherState(): WatcherState {
  return state.watcherState;
}

function snapshot(): Session[] {
  // Recency-sorted. A live session is by definition recently written, so
  // lastEventAt desc naturally floats live sessions to the top without a
  // separate liveness tiebreak.
  const arr = [...state.sessions.values()];
  arr.sort((a, b) => b.lastEventAt - a.lastEventAt);
  return arr;
}

export function getSnapshot(): Session[] {
  return snapshot();
}

export function subscribe(fn: (snap: Session[]) => void): () => void {
  state.subscribers.add(fn);
  return () => { state.subscribers.delete(fn); };
}

function broadcast(): void {
  const snap = snapshot();
  for (const fn of state.subscribers) {
    try { fn(snap); } catch { /* subscriber threw; isolate */ }
  }
  scheduleCacheSave();
}

function scheduleCacheSave(): void {
  if (state.cacheSaveTimer) clearTimeout(state.cacheSaveTimer);
  state.cacheSaveTimer = setTimeout(() => {
    state.cacheSaveTimer = null;
    void saveCache();
  }, CACHE_SAVE_DEBOUNCE_MS);
}

interface CacheFile {
  version: number;
  sessions: Session[];
}

async function saveCache(): Promise<void> {
  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    const payload: CacheFile = { version: CACHE_VERSION, sessions: [...state.sessions.values()] };
    const tmp = `${CACHE_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify(payload));
    await rename(tmp, CACHE_PATH);
  } catch {
    // cache save failures are non-fatal
  }
}

async function loadCache(): Promise<void> {
  let raw: string;
  try { raw = await readFile(CACHE_PATH, 'utf-8'); } catch { return; }
  let parsed: CacheFile;
  try { parsed = JSON.parse(raw) as CacheFile; } catch { return; }
  if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.sessions)) return;
  for (const s of parsed.sessions) {
    if (!s || typeof s.sessionId !== 'string' || typeof s.source !== 'string') continue;
    // `knownSize` is trusted from cache so the boot drain can read only the
    // delta. The event index is not persisted: `state.indexed` starts empty,
    // and `emitParsed` gates drain emits until `buildIndexFromDisk` runs on
    // first Agent Panel read, so a partial index is never observable.
    state.sessions.set(s.sessionId, { ...s });
  }
}

// Codex sessions registered before the adapter started capturing gitBranch
// land in the cache without one. Fill them once on boot so /api/sessions is
// uniform across sources. Per-cwd memo keeps git spawns to one-per-project
// even when many sessions share the same repo.
async function backfillGitBranches(): Promise<void> {
  const byCwd = new Map<string, Promise<string | undefined>>();
  const tasks: Array<Promise<void>> = [];
  for (const s of state.sessions.values()) {
    if (s.gitBranch || !s.project) continue;
    let lookup = byCwd.get(s.project);
    if (!lookup) {
      lookup = readGitBranch(s.project);
      byCwd.set(s.project, lookup);
    }
    tasks.push(lookup.then((branch) => {
      if (branch) s.gitBranch = branch;
    }));
  }
  if (tasks.length) await Promise.all(tasks);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Reconcile sessions that survived a repo rename/move. Claude preserves the
// original cwd near the head of the transcript, but later appended lines carry
// the new cwd. We only migrate when the old project path is gone and the latest
// observed cwd exists, so ordinary cross-repo cwd changes do not silently
// regroup active sessions.
export async function maybeReconcileSessionProject(session: Session, cwd: string): Promise<boolean> {
  const next = cwd.trim();
  if (!next || next === session.project) return false;
  if (!(await pathExists(next))) return false;
  if (await pathExists(session.project)) return false;

  session.project = next;
  session.projectName = basename(next);
  return true;
}

// Heal a session whose cached `project` path no longer exists on disk (the
// directory was renamed while the session was idle, so its frozen cwd points
// at a dead path). `maybeReconcileSessionProject` only fires when a session is
// still being written and its tail carries a fresh cwd; an idle session emits
// nothing and stays stranded. This recovers it from its live siblings instead.
//
// Claude mirrors every session of a project under one slug directory
// (~/.claude/projects/<slug>/), and on rename the transcripts re-home under the
// new slug, so co-located siblings whose cwd still resolves are the authority
// for the current path. We adopt the freshest-existing sibling's project.
//
// Pure: `projectExists` is supplied by the caller (which has already statted
// the candidate paths) so this stays testable without filesystem IO. Returns
// the canonical path, or null when nothing in the slug resolves (a genuine
// deletion, not a rename — leave it stranded rather than guess).
//
// Codex has no project-slug directory (rollouts group by date), so there is no
// reliable co-location signal; Codex strays return null and are left to the
// notify-replay guard rather than healed by a fragile basename match.
export function resolveStrayProject(
  stray: Session,
  candidates: Iterable<Session>,
  projectExists: (path: string) => boolean,
): string | null {
  if (stray.source !== 'claude') return null;
  const slugDir = dirname(stray.transcriptPath);
  let best: Session | null = null;
  for (const s of candidates) {
    if (s.source !== 'claude') continue;
    if (s.sessionId === stray.sessionId) continue;
    if (dirname(s.transcriptPath) !== slugDir) continue;
    if (!projectExists(s.project)) continue;
    if (!best || s.lastEventAt > best.lastEventAt) best = s;
  }
  return best ? best.project : null;
}

// Sweep the session map for strays whose project path vanished and re-home each
// onto its live siblings' path. Runs once at boot (so the boot scan sees the
// healed path and routes to trust-cache instead of perpetually cold-probing a
// dead path) and once per safety scan (to catch renames that land while the
// sidecar is live). Idempotent: a session whose project already exists is
// skipped, and re-running with no new strays is a no-op.
async function reconcileStrayProjects(): Promise<void> {
  const all = [...state.sessions.values()];
  const distinct = new Set(all.map((s) => s.project));
  const existing = new Set<string>();
  await Promise.all(
    [...distinct].map(async (p) => {
      if (await pathExists(p)) existing.add(p);
    }),
  );

  let changed = false;
  for (const session of all) {
    if (existing.has(session.project)) continue;
    const next = resolveStrayProject(session, all, (p) => existing.has(p));
    if (next && next !== session.project) {
      session.project = next;
      session.projectName = basename(next);
      changed = true;
    }
  }
  if (changed) broadcast();
}

// Boot-time scan decision for one observed transcript. Pure so the routing is
// testable without driving the chokidar/filesystem stack.
//   trust-cache: file byte-unchanged since the cached snapshot; cached facts
//                (lastTurnClosed, lastEventAt, snippets) are still true.
//   cold-probe:  re-read head + tail (recovers turn state/title/cwd) without
//                a byte delta. Used for fresh sessions AND when the cached
//                project path vanished — the latter needs the tail re-read so
//                `maybeReconcileSessionProject` sees the post-rename cwd even
//                when the transcript itself has not grown since the last save.
//   drain:       warm path; consume the byte delta through the tail loop.
//
// `cachedProjectMissing` suppresses trust-cache: a byte-unchanged file whose
// project disappeared must still be probed, otherwise `drain` would
// early-return on the zero-length delta and never reconcile.
export type BootScan = 'trust-cache' | 'cold-probe' | 'drain';

export function chooseBootScan(opts: {
  isNew: boolean;
  knownSize: number;
  lastEventAt: number;
  mtimeMs: number;
  watcherIsLive: boolean;
  cachedProjectMissing: boolean;
}): BootScan {
  const { isNew, knownSize, lastEventAt, mtimeMs, watcherIsLive, cachedProjectMissing } = opts;
  if (!cachedProjectMissing && !isNew && lastEventAt > 0 && mtimeMs <= lastEventAt) return 'trust-cache';
  if (!watcherIsLive && (isNew || knownSize === 0 || cachedProjectMissing)) return 'cold-probe';
  return 'drain';
}

function attachTail(adapter: SourceAdapter, session: Session): void {
  if (state.tailWatchers.has(session.sessionId)) return;
  // chokidar on a single file path: watches the file with the same backend
  // as fs.watch but adds error recovery. ignoreInitial keeps the watcher
  // from firing for the file's current state; we only care about deltas.
  const watcher = chokidar.watch(session.transcriptPath, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: false,
  });
  const onFire = (): void => {
    const entry = state.tailWatchers.get(session.sessionId);
    if (!entry) return;
    entry.lastFireAt = Date.now();
    if (entry.draining) {
      // A read is in flight. Flag so it re-runs immediately after, picking
      // up bytes appended during the read.
      entry.pending = true;
      return;
    }
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      void drainAndContinue(adapter, session);
    }, TAIL_DEBOUNCE_MS);
  };
  watcher.on('change', onFire);
  // If the harness rotates the file, chokidar emits `add` for the
  // re-created path. drain() already handles size-shrunk-than-knownSize by
  // resetting cursors, so an add fires the same code path.
  watcher.on('add', onFire);
  watcher.on('error', (err) => {
    console.error(`tail watcher error for ${session.sessionId}:`, err);
  });
  const entry: TailWatcherEntry = {
    watcher,
    lastFireAt: Date.now(),
    debounceTimer: null,
    draining: false,
    pending: false,
  };
  state.tailWatchers.set(session.sessionId, entry);
}

function detachTail(sessionId: string): void {
  const entry = state.tailWatchers.get(sessionId);
  if (!entry) return;
  void entry.watcher.close();
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  state.tailWatchers.delete(sessionId);
}

async function drainAndContinue(adapter: SourceAdapter, session: Session): Promise<void> {
  const entry = state.tailWatchers.get(session.sessionId);
  if (entry) entry.draining = true;
  try {
    await drain(adapter, session);
    // If the tail watcher fired during the drain, run once more without
    // waiting for the debounce. Loop until quiet.
    while (true) {
      const e = state.tailWatchers.get(session.sessionId);
      if (!e || !e.pending) break;
      e.pending = false;
      await drain(adapter, session);
    }
  } finally {
    const e = state.tailWatchers.get(session.sessionId);
    if (e) e.draining = false;
  }
}

// Read new bytes since `session.knownSize`, parse each new line, fan out
// activity events, and fold the per-line turn-boundary signal. Caps reads to
// DRAIN_CHUNK_BYTES per pass; subsequent bytes are picked up on the next tail
// event or recursion.
async function drain(adapter: SourceAdapter, session: Session): Promise<void> {
  let st: Awaited<ReturnType<typeof stat>>;
  try { st = await stat(session.transcriptPath); } catch { return; }

  const truncated = st.size < session.knownSize;
  if (truncated) {
    // File truncated/rotated. Reset cursors and rebuild the event index.
    session.knownSize = 0;
    resetIndex(session.sessionId);
  }
  if (st.size === session.knownSize) return;

  const start = session.knownSize;
  const end = Math.min(st.size, start + DRAIN_CHUNK_BYTES);
  const file = Bun.file(session.transcriptPath);
  const buf = await file.slice(start, end).bytes();
  const text = new TextDecoder().decode(buf);

  let pos = 0;
  let lastSnippet = '';
  let entryClosed = session.lastTurnClosed;
  let latestCwd: string | undefined;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) break;
    const line = text.slice(pos, nl);
    const lineStart = start + pos;
    if (line.length > 0) {
      const r = adapter.processLine(line);
      if (r) {
        if (r.cwd) latestCwd = r.cwd;
        if (r.event) {
          emitParsed(session.sessionId, lineStart, r.event);
          const snip = adapter.snippetFor(r.event);
          if (snip) lastSnippet = snip;
          // Capture user prompts. snippetFor returns empty for synthetic
          // users (tool results, system reminders, [Caveat:] lines), so a
          // non-empty user snippet is a real prompt. `firstPrompt` is sticky
          // (set once, used as a fallback session name); `lastUserPrompt`
          // tracks the most recent turn for the notification body.
          if (r.event.type === 'user' && snip) {
            const cleaned = snip.replace(/^→\s*/, '').trim();
            if (cleaned) {
              if (!session.firstPrompt) session.firstPrompt = cleaned.slice(0, 120);
              session.lastUserPrompt = cleaned.slice(0, 240);
            }
          }
        }
        if (r.title) {
          session.title = r.title;
        }
        if (r.usage) {
          session.tokenUsage = r.usage;
        }
        if (r.turnClosed !== undefined) entryClosed = r.turnClosed;
      }
    }
    pos = nl + 1;
  }

  // Commit position at the start of any partial trailing line.
  session.knownSize = start + pos;
  session.lastEventAt = st.mtimeMs;
  session.lastTurnClosed = entryClosed;
  if (lastSnippet) session.lastSnippet = lastSnippet;
  if (latestCwd) await maybeReconcileSessionProject(session, latestCwd);

  broadcast();

  // If we capped this pass, continue draining without waiting for another
  // tail event. The recursion is bounded by file size at the time of entry.
  if (end < st.size) {
    await drain(adapter, session);
  }
}

// Discovery callback: a file path was created or appended to. Look up or
// register the session, ensure a tail watcher is attached, kick a drain to
// process any new bytes.
//
// For cached sessions whose on-disk mtime hasn't advanced since the cached
// `lastEventAt`, the historical scan is skipped: cached facts are trusted
// and `knownSize` is fast-forwarded to current file size. Boot stays fast;
// the event index for these sessions is built lazily by `readEvents` on
// first Agent Panel read.
// Cold-boot fast path. Samples the head (first COLD_PROBE_BYTES) and tail
// (last COLD_PROBE_BYTES) of the file, runs each sampled line through the
// adapter to update lastTurnClosed, title, firstPrompt, lastSnippet,
// lastUserPrompt, then sets `knownSize` to current EOF so the live tail
// watcher picks up only future bytes. Never calls `emitParsed`; the event
// index for this session is built later by `buildIndexFromDisk` on first
// Agent Panel read.
//
// Files <= 2 * COLD_PROBE_BYTES are read in one pass to avoid head/tail
// overlap.
async function coldStartProbe(adapter: SourceAdapter, session: Session): Promise<void> {
  let st: Awaited<ReturnType<typeof stat>>;
  try { st = await stat(session.transcriptPath); } catch { return; }
  if (st.size === 0) return;

  const file = Bun.file(session.transcriptPath);
  let entryClosed = session.lastTurnClosed;
  let lastSnippet = '';
  let latestCwd: string | undefined;

  const processBuf = (buf: Uint8Array, startOffset: number): void => {
    const text = new TextDecoder().decode(buf);
    let pos = 0;
    if (startOffset > 0) {
      // Mid-byte cut on the tail slice — drop the partial first line.
      const firstNl = text.indexOf('\n');
      if (firstNl < 0) return;
      pos = firstNl + 1;
    }
    while (pos < text.length) {
      const nl = text.indexOf('\n', pos);
      if (nl < 0) break;
      const line = text.slice(pos, nl);
      if (line.length > 0) {
        const r = adapter.processLine(line);
        if (r) {
          if (r.cwd) latestCwd = r.cwd;
          if (r.event) {
            const snip = adapter.snippetFor(r.event);
            if (snip) lastSnippet = snip;
            if (r.event.type === 'user' && snip) {
              const cleaned = snip.replace(/^→\s*/, '').trim();
              if (cleaned) {
                if (!session.firstPrompt) session.firstPrompt = cleaned.slice(0, 120);
                session.lastUserPrompt = cleaned.slice(0, 240);
              }
            }
          }
          if (r.title) session.title = r.title;
          if (r.usage) session.tokenUsage = r.usage;
          if (r.turnClosed !== undefined) entryClosed = r.turnClosed;
        }
      }
      pos = nl + 1;
    }
  };

  if (st.size <= 2 * COLD_PROBE_BYTES) {
    const buf = await file.slice(0, st.size).bytes();
    processBuf(buf, 0);
  } else {
    const head = await file.slice(0, COLD_PROBE_BYTES).bytes();
    processBuf(head, 0);
    const tailStart = st.size - COLD_PROBE_BYTES;
    const tail = await file.slice(tailStart, st.size).bytes();
    processBuf(tail, tailStart);
  }

  session.knownSize = st.size;
  session.lastEventAt = st.mtimeMs;
  session.lastTurnClosed = entryClosed;
  if (lastSnippet) session.lastSnippet = lastSnippet;
  if (latestCwd) await maybeReconcileSessionProject(session, latestCwd);

  broadcast();
}

async function onSessionFileObserved(adapter: SourceAdapter, filePath: string): Promise<void> {
  const sessionId = adapter.filePathToSessionId(filePath);
  if (!sessionId) return;

  let st: Awaited<ReturnType<typeof stat>>;
  try { st = await stat(filePath); } catch { return; }

  let session = state.sessions.get(sessionId);
  const isNew = !session;

  if (!session) {
    const header = await adapter.readHeader(filePath).catch(() => null);
    if (!header || !header.cwd) return;
    session = {
      sessionId,
      source: adapter.id,
      project: header.cwd,
      projectName: basename(header.cwd),
      transcriptPath: filePath,
      // A file being created/appended is presumptively mid-turn; the first
      // drain or probe folds the real turn-boundary signal, and the read-time
      // recency gate keeps this honest even if no signal ever arrives.
      lastTurnClosed: false,
      lastEventAt: 0,
      lastSnippet: '',
      knownSize: 0,
      gitBranch: header.gitBranch,
      entrypoint: header.entrypoint,
    };
    state.sessions.set(sessionId, session);
  } else if (session.transcriptPath !== filePath) {
    session.transcriptPath = filePath;
  }

  // A vanished cached project path means a repo rename/move happened while the
  // sidecar was down. The grouping in the cache can no longer be trusted, so the
  // scan must re-read the transcript tail (where the post-rename cwd lives) even
  // if the file has not grown since the last cache save.
  const cachedProjectMissing = !isNew && !(await pathExists(session.project));
  const scan = chooseBootScan({
    isNew,
    knownSize: session.knownSize,
    lastEventAt: session.lastEventAt,
    mtimeMs: st.mtimeMs,
    watcherIsLive: state.watcherState === 'live',
    cachedProjectMissing,
  });

  if (scan === 'trust-cache') {
    // Byte-for-byte unchanged since the cached snapshot: the cached facts are
    // still true. Fast-forward knownSize to EOF as a defensive consistency
    // check.
    session.knownSize = st.size;
  }

  attachTail(adapter, session);

  // cold-probe: head + tail re-read in O(128KB) regardless of file size,
  // recovering turn state/title/firstPrompt/lastSnippet/cwd without a byte
  // delta.
  // drain: warm path; the byte delta flows through the regular tail loop.
  // `emitParsed` gates on `state.indexed`, so a drain before the Agent Panel ever
  // opens this session is a status-only no-op for the event index.
  if (scan === 'cold-probe') {
    await coldStartProbe(adapter, session);
  } else if (scan === 'drain') {
    await drainAndContinue(adapter, session);
  }
}

export async function startWatcher(): Promise<void> {
  // Idempotent: --hot re-evaluates the module, but the watcher handles and
  // the sessions map live on the global singleton from the first eval.
  if (state.discoveryTeardowns.length > 0) return;

  await loadCache();
  await backfillGitBranches();
  // Heal strays before the boot scan so a renamed-away session's project path
  // is current when `chooseBootScan` evaluates `cachedProjectMissing`: it then
  // routes to trust-cache instead of forever cold-probing a dead path (and
  // replaying its terminal transition).
  await reconcileStrayProjects();
  state.watcherState = 'reconciling';

  const handles = adapters.map((adapter) => {
    const handle = adapter.startDiscovery((p) => onSessionFileObserved(adapter, p));
    state.discoveryTeardowns.push(handle.teardown);
    state.discoveryRescans.push(handle.rescan);
    return handle;
  });

  // Boot reconcile: await every adapter's initial scan. The scans call
  // onSessionFileObserved, which awaits the drain, so once Promise.all
  // resolves every session's first drain has completed and the status map
  // reflects the live filesystem.
  await Promise.all(handles.map((h) => h.initialScan().catch(() => undefined)));

  state.watcherState = 'live';
  void saveCache();

  if (!state.pruneTimer) {
    state.pruneTimer = setInterval(() => {
      void pruneDeleted();
      pruneTailWatchers();
    }, PRUNE_INTERVAL_MS);
  }
  if (!state.safetyTimer) {
    state.safetyTimer = setInterval(() => { void runSafetyScan(); }, SAFETY_INTERVAL_MS);
  }
}

// Detach tail watchers that have not fired in TAIL_GRACE_MS. The owning
// session stays in `state.sessions`; if it gets appended to later, the
// dir-level watcher fires and onSessionFileObserved reattaches.
function pruneTailWatchers(): void {
  const now = Date.now();
  for (const [sessionId, entry] of state.tailWatchers) {
    if (now - entry.lastFireAt > TAIL_GRACE_MS && !entry.draining) {
      detachTail(sessionId);
    }
  }
}

// Safety belt. Two jobs:
//   1) Re-enumerate session files via each adapter so any file the live
//      chokidar watcher missed (FSEvents flakes, watcher in a degraded
//      state) gets registered. Adapter rescans are cheap: SQLite read for
//      Codex, readdir for Claude. Files we already know about go through
//      onSessionFileObserved which is dedup-safe.
//   2) Catch sessions whose tail watcher dropped a grow or shrink event.
//      `drain` handles both directions and resets indexes on shrinkage.
// There is deliberately no stale-working sweep: liveness is derived from
// lastEventAt recency at read time, so a harness that died mid-turn ages out
// of 'live' on its own.
export async function runSafetyScan(): Promise<void> {
  for (const rescan of state.discoveryRescans) {
    try { await rescan(); } catch { /* best-effort */ }
  }
  // Re-home any session whose project path vanished (a rename that landed while
  // the sidecar was live). Runs after the rescan so freshly-discovered sessions
  // are considered as sibling evidence.
  await reconcileStrayProjects();
  for (const session of state.sessions.values()) {
    let st: Awaited<ReturnType<typeof stat>>;
    try { st = await stat(session.transcriptPath); } catch { continue; }
    if (st.size !== session.knownSize) {
      const adapter = adapterFor(session.source);
      attachTail(adapter, session);
      await drainAndContinue(adapter, session);
    }
  }
}

// Walks `state.sessions` and drops any entry whose JSONL no longer exists.
export async function pruneDeleted(): Promise<number> {
  const candidates = [...state.sessions.entries()];
  const removed: string[] = [];
  for (const [sessionId, entry] of candidates) {
    try {
      await stat(entry.transcriptPath);
    } catch (err) {
      const code = (err as { code?: string } | null | undefined)?.code;
      if (code === 'ENOENT') removed.push(sessionId);
    }
  }
  if (removed.length === 0) return 0;
  for (const sessionId of removed) {
    detachTail(sessionId);
    state.sessions.delete(sessionId);
    resetIndex(sessionId);
  }
  broadcast();
  return removed.length;
}

export async function stopWatcher(): Promise<void> {
  for (const teardown of state.discoveryTeardowns) {
    try { teardown(); } catch { /* best-effort */ }
  }
  state.discoveryTeardowns.length = 0;
  state.discoveryRescans.length = 0;
  for (const sessionId of [...state.tailWatchers.keys()]) detachTail(sessionId);
  if (state.cacheSaveTimer) {
    clearTimeout(state.cacheSaveTimer);
    state.cacheSaveTimer = null;
  }
  if (state.pruneTimer) {
    clearInterval(state.pruneTimer);
    state.pruneTimer = null;
  }
  if (state.safetyTimer) {
    clearInterval(state.safetyTimer);
    state.safetyTimer = null;
  }
  state.watcherState = 'idle';
  await saveCache();
}
