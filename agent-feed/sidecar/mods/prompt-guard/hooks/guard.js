// Whether a mod may start one more turn by submitting a prompt. Pure, so it can be tested on its
// own: the hooks module reads and writes the state in $.store, because a hooks module can pass `$`
// only to functions in its own file.
//
// The limit that matters is `sinceUser`. Measured on Claude Code 2.1.301 (2026-10-16): a mod that
// submits from `turn.complete` started a turn about once a second until something stopped it, and
// an interactive session has no turn or budget limit of its own. Escape is the only built-in brake:
// after it, Claude Code refuses every mod's prompt until the person types.

export const LIMITS = {
  /** Prompts mods may send in a session since the person last typed there. */
  sinceUser: 3,
  /** Prompts mods may send in one session in the last hour. */
  sessionPerHour: 6,
  /** Prompts mods may send across every session on the machine in the last hour. */
  machinePerHour: 20,
  hourMs: 60 * 60 * 1000,
  /** The same text again within this long is refused. */
  duplicateMs: 10 * 60 * 1000,
  /** A prompt that never reported back stops blocking the next one after this long. */
  pendingStaleMs: 10 * 60 * 1000,
  /** A session nothing has happened in for this long is forgotten, pause and all. */
  forgetSessionMs: 7 * 24 * 60 * 60 * 1000,
}

/**
 * Whether a prompt event is the person's own. Measured on 2.1.301: a typed prompt, and one pasted
 * into the pane (which is how the panel's composer sends), carries `origin: { kind: 'composer' }`;
 * one sent from the phone or claude.ai through Remote Control carries `{ kind: 'bridge' }`; a mod's
 * carries `{ kind: 'plugin', name }`.
 */
export function isUsersOwn(origin) {
  return origin === undefined || origin === null || origin.kind === 'composer' || origin.kind === 'bridge'
}

/** The mod that submitted a prompt, or null when no mod did. */
export function submittingMod(origin) {
  return origin && origin.kind === 'plugin' && typeof origin.name === 'string' ? origin.name : null
}

function normalize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    paused: s.paused === true,
    machine: Array.isArray(s.machine) ? s.machine.filter((at) => typeof at === 'number') : [],
    sessions: s.sessions && typeof s.sessions === 'object' && !Array.isArray(s.sessions) ? { ...s.sessions } : {},
  }
}

function sessionOf(state, sid) {
  const s = state.sessions[sid] ?? {}
  return {
    sinceUser: typeof s.sinceUser === 'number' ? s.sinceUser : 0,
    hourly: Array.isArray(s.hourly) ? s.hourly.filter((at) => typeof at === 'number') : [],
    pendingAt: typeof s.pendingAt === 'number' ? s.pendingAt : null,
    recent: s.recent && typeof s.recent === 'object' && !Array.isArray(s.recent) ? { ...s.recent } : {},
    lastAt: typeof s.lastAt === 'number' ? s.lastAt : 0,
  }
}

const within = (now, windowMs) => (at) => now - at < windowMs

/**
 * Whether one more prompt from a mod may enter session `sid` now. Returns the next state either
 * way, so a refusal also drops what has aged out. `hash` names the text, for the duplicate rule.
 */
export function admit(raw, sid, hash, now) {
  const state = normalize(raw)
  const s = sessionOf(state, sid)
  state.machine = state.machine.filter(within(now, LIMITS.hourMs))
  s.hourly = s.hourly.filter(within(now, LIMITS.hourMs))
  for (const [h, at] of Object.entries(s.recent)) {
    if (typeof at !== 'number' || now - at >= LIMITS.duplicateMs) delete s.recent[h]
  }
  if (s.pendingAt !== null && now - s.pendingAt >= LIMITS.pendingStaleMs) s.pendingAt = null
  // A session quiet for a week is forgotten, so the store does not grow with every session ever run.
  for (const other of Object.keys(state.sessions)) {
    if (other !== sid && now - sessionOf(state, other).lastAt >= LIMITS.forgetSessionMs) delete state.sessions[other]
  }
  s.lastAt = now
  state.sessions[sid] = s

  const refuse = (reason) => ({ ok: false, reason, state })
  if (state.paused) return refuse('mod prompts are paused with /pause-mod-prompts; /resume-mod-prompts turns them back on')
  if (s.pendingAt !== null) return refuse('a prompt a mod sent is still waiting to enter')
  if (s.sinceUser >= LIMITS.sinceUser) {
    return refuse(`paused: mods sent ${s.sinceUser} prompts since you last typed here; type anything to let them send again`)
  }
  if (s.hourly.length >= LIMITS.sessionPerHour) return refuse(`mods sent ${s.hourly.length} prompts in this session in the last hour`)
  if (state.machine.length >= LIMITS.machinePerHour) return refuse(`mods sent ${state.machine.length} prompts on this machine in the last hour`)
  if (s.recent[hash] !== undefined) return refuse('a mod sent the same text less than 10 minutes ago')

  s.sinceUser += 1
  s.hourly.push(now)
  state.machine.push(now)
  s.recent[hash] = now
  s.pendingAt = now
  return { ok: true, state }
}

/** The admitted prompt entered, or something after the guard dropped it. */
export function settled(raw, sid) {
  const state = normalize(raw)
  state.sessions[sid] = { ...sessionOf(state, sid), pendingAt: null }
  return state
}

/** The person typed in session `sid` at `now`, so mods may send there again. */
export function userTyped(raw, sid, now) {
  const state = normalize(raw)
  state.sessions[sid] = { ...sessionOf(state, sid), sinceUser: 0, lastAt: now }
  return state
}

export function setPaused(raw, paused) {
  return { ...normalize(raw), paused }
}
