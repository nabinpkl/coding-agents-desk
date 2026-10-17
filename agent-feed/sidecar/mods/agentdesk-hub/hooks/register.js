// Delivers agent-hub messages into this Claude session, in place of the development-channel flag.
// See "Delivering into a Claude session through a mod" in docs/agent-messaging.md.
//
// The reader (`src/hubReaderMain.ts`) holds the session's hub stream and writes one line per
// message; this module submits each as a prompt, one at a time, and confirms it to the hub through
// `src/hubConfirmMain.ts` only once the prompt has entered. A prompt that is dropped (the prompt
// guard, a stopped session) stays queued here, unconfirmed, and is tried again when the person next
// types; the hub requeues anything unconfirmed if the stream drops. Load it beside prompt-guard,
// which bounds how many turns these prompts can start.
import { LineBuffer, parseReaderLine, framePrompt, DeliveryQueue, promptCarriesMessage } from './hubMessages.js'

const ENTERED_KEY = 'entered'
/** Messages submitted whose prompt has not yet been seen to enter: the reload gap (`arrivedAgain`). */
const SENT_KEY = 'sent'
/** Longer than a message lives in the hub (seven days), so a late redelivery is still recognised. */
const ENTERED_TTL_MS = 8 * 24 * 60 * 60 * 1000
const RESTART_MS = [1000, 2000, 5000, 10000, 30000]

/** The reader this session is running, and the queue it fills. Replaced when the session id changes. */
let current = null
let pumping = false

async function bunPath($) {
  return (await $.env.get('AGENTDESK_BUN_PATH')) || 'bun'
}

/** The sidecar's source tree, which this mod sits inside: `mods/agentdesk-hub` under `agent-feed/sidecar`. */
function sidecarScript($, name) {
  return $.plugin.root + '/../../src/' + name
}

async function loadIds($, key, sid) {
  const all = (await $.store.get(key)) ?? {}
  const mine = all[sid] && typeof all[sid] === 'object' ? all[sid] : {}
  return new Set(Object.keys(mine))
}

/** Adds or removes one message id for `sid` under `key`, dropping ids older than a message lives. */
async function setId($, key, sid, messageId, present) {
  const now = Date.now()
  const all = (await $.store.get(key)) ?? {}
  for (const [s, ids] of Object.entries(all)) {
    for (const [id, at] of Object.entries(ids ?? {})) if (now - at > ENTERED_TTL_MS) delete ids[id]
    if (Object.keys(ids ?? {}).length === 0) delete all[s]
  }
  const mine = { ...(all[sid] ?? {}) }
  if (present) mine[messageId] = now
  else delete mine[messageId]
  if (Object.keys(mine).length > 0) all[sid] = mine
  else delete all[sid]
  await $.store.set(key, all)
}

async function markEntered($, sid, messageId) {
  await setId($, ENTERED_KEY, sid, messageId, true)
  await setId($, SENT_KEY, sid, messageId, false)
}

async function confirm($, messageId, streamId) {
  const run = await $.process.run([await bunPath($), sidecarScript($, 'hubConfirmMain.ts'), messageId, streamId], { timeoutMs: 20000 })
  if (run.exitCode !== 0) $.ui.log(`could not confirm ${messageId} to the hub: ${run.stderr.trim()}`, { to: 'debug' })
}

/** Submits the queue's head, then the next, until it is empty or a prompt is dropped. */
async function pump($) {
  const run = current
  if (pumping || !run || !run.queue) return
  pumping = true
  try {
    for (;;) {
      const head = run.queue.head()
      if (!head || run !== current) return
      let framed
      try {
        framed = framePrompt(head)
      } catch (err) {
        // A message this mod cannot frame stays unconfirmed, so the hub keeps it, and is set aside
        // here rather than holding back every message behind it.
        $.ui.log(`could not deliver the message from ${head.fromName}: ${String(err)}`)
        run.queue.setAsideHead()
        continue
      }
      const { text, asUser } = framed
      // Recorded before the submit, because a reload of this mod can land while the prompt goes
      // in, and then nothing after the submit runs.
      await setId($, SENT_KEY, run.sid, head.message.id, true)
      run.sent.add(head.message.id)
      let result
      try {
        result = await $.prompt.submit(asUser ? { text, asUser: true } : { text })
      } catch (err) {
        $.ui.log(`could not submit the message from ${head.fromName}: ${String(err)}`)
        await setId($, SENT_KEY, run.sid, head.message.id, false)
        run.sent.delete(head.message.id)
        return
      }
      if (result && result.drop !== undefined) {
        $.ui.log(`holding a message from ${head.fromName} until you next type: ${result.drop}`)
        await setId($, SENT_KEY, run.sid, head.message.id, false)
        run.sent.delete(head.message.id)
        return
      }
      const messageId = head.message.id
      const streamId = run.queue.enteredHead()
      await markEntered($, run.sid, messageId)
      await confirm($, messageId, streamId)
    }
  } finally {
    pumping = false
  }
}

/**
 * A message this mod submitted but never saw enter, pushed again by the hub. That is the reload
 * gap: the previous copy of the mod was replaced as its prompt went in, so it neither confirmed it
 * nor recorded it. The session's own messages say whether it arrived; if so it is only confirmed,
 * and if not it is submitted as if new. Returns whether it was handled here.
 */
async function arrivedAgain($, run, delivery) {
  const id = delivery.message.id
  // Still waiting in this copy's own queue (its prompt may be on its way in now): not the gap.
  if (!run.sent.has(id) || run.queue.entered.has(id) || run.queue.holds(id)) return false
  run.sent.delete(id)
  if (!promptCarriesMessage(await $.session.messages(), id)) {
    await setId($, SENT_KEY, run.sid, id, false)
    return false
  }
  run.queue.entered.add(id)
  await markEntered($, run.sid, id)
  $.ui.log(`a message from ${delivery.fromName} had already gone in; confirming it rather than sending it twice`, { to: 'debug' })
  await confirm($, id, delivery.streamId)
  return true
}

const AFTER_HOOK_MS = 250

/**
 * What a prompt event asks for, done once the hook has returned: Claude Code refuses a
 * $.prompt.submit made inside a prompt.submit hook, since it would wait on the turn the hook is
 * holding (measured), and a call made after the hook has returned runs in the mod's own context.
 */
async function afterPrompt($, personTyped) {
  await $.clock.sleep(AFTER_HOOK_MS)
  try {
    await followSession($)
    // The person typing is what may let a held message through the prompt guard.
    if (personTyped) await pump($)
  } catch (err) {
    $.ui.log(`could not check the hub reader: ${String(err)}`, { to: 'debug' })
  }
}

/** Runs the reader for `run.sid` until it is replaced, starting it again when it stops on its own. */
async function runReader($, run) {
  const sid = run.sid
  run.sent = await loadIds($, SENT_KEY, sid)
  run.queue = new DeliveryQueue(await loadIds($, ENTERED_KEY, sid))
  const cwd = await $.session.cwd()
  let failures = 0
  while (!run.stopped) {
    const buffer = new LineBuffer()
    run.child = $.process.spawn({ argv: [await bunPath($), sidecarScript($, 'hubReaderMain.ts'), sid, cwd] })
    try {
      for await (const { stream, text } of run.child) {
        if (stream !== 'stdout') {
          $.ui.log(text.trim(), { to: 'debug' })
          continue
        }
        failures = 0
        for (const line of buffer.push(text)) {
          const parsed = parseReaderLine(line)
          if (!parsed || parsed.type !== 'message') continue
          if (await arrivedAgain($, run, parsed)) continue
          if (run.queue.arrive(parsed) === 'confirm') await confirm($, parsed.message.id, parsed.streamId)
          else void pump($)
        }
      }
    } catch (err) {
      $.ui.log(`the hub reader failed: ${String(err)}`, { to: 'debug' })
    }
    if (run.stopped) return
    const wait = RESTART_MS[Math.min(failures, RESTART_MS.length - 1)]
    failures += 1
    $.ui.log(`the hub reader stopped; starting it again in ${wait / 1000}s`, { to: 'debug' })
    await $.clock.sleep(wait)
  }
}

/** The session id moves on /clear and on a resume; the hub must know the session by the new one. */
async function followSession($) {
  const sid = await $.session.id()
  if (current && current.sid === sid) return
  const previous = current
  // Claimed before anything is awaited, so a session.start and a prompt arriving together start one
  // reader rather than two.
  const run = { sid, queue: null, sent: new Set(), stopped: false, child: null }
  current = run
  if (previous) {
    previous.stopped = true
    // Leaving the spawn's loop is what ends the child.
    await previous.child?.return?.()
  }
  void runReader($, run)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void followSession($)
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    const personTyped = Boolean(result && result.drop === undefined && e.origin && (e.origin.kind === 'composer' || e.origin.kind === 'bridge'))
    void afterPrompt($, personTyped)
    return result
  }).catch(async ($, e, next) => {
    // This hook only watches prompts; whatever goes wrong in it must never hold one back.
    return next(e)
  })
}
