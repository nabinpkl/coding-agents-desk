// Bounds how many turns other mods can start by submitting prompts. Every `$.prompt.submit` any mod
// makes reaches this module as a `prompt.submit` event whose origin names that mod, so one guard
// covers them all and one store counts them across every session on the machine. A prompt the
// person types is what lets mods send again. See guard.js for the limits and why they exist.
import { admit, settled, userTyped, setPaused, isUsersOwn, submittingMod, LIMITS } from './guard.js'

const KEY = 'guard'

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Refuses a mod's prompt when the guard does, or when the guard itself cannot run. */
async function judge($, mod, text) {
  try {
    const sid = await $.session.id()
    const decision = admit(await $.store.get(KEY), sid, await sha256(text), Date.now())
    await $.store.set(KEY, decision.state)
    if (!decision.ok) {
      $.ui.log(`did not let ${mod} start a turn: ${decision.reason}`)
      if (decision.reason.startsWith('paused')) $.ui.status(decision.reason)
      return { sid, refusal: `${mod}: ${decision.reason}` }
    }
    return { sid }
  } catch (err) {
    $.ui.log(`did not let ${mod} start a turn: the guard could not check it (${String(err)})`)
    return { sid: undefined, refusal: `${mod}: the prompt guard could not check this prompt` }
  }
}

async function release($, sid) {
  try {
    await $.store.set(KEY, settled(await $.store.get(KEY), sid))
  } catch (err) {
    $.ui.log(`could not clear the waiting prompt: ${String(err)}`)
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pause-mod-prompts', description: 'Stop every mod starting turns, in every session on this machine' })
    await $.command.register({ name: 'resume-mod-prompts', description: 'Let mods start turns again, within the prompt guard limits' })
    return next(e)
  })

  on('command.run', { command: 'pause-mod-prompts' }, async ($) => {
    await $.store.set(KEY, setPaused(await $.store.get(KEY), true))
    $.ui.status('mod prompts paused with /pause-mod-prompts')
    return { text: 'No mod can start a turn in any session on this machine until /resume-mod-prompts.' }
  })

  on('command.run', { command: 'resume-mod-prompts' }, async ($) => {
    await $.store.set(KEY, setPaused(await $.store.get(KEY), false))
    $.ui.status(undefined)
    return { text: `Mods may start turns again: at most ${LIMITS.sinceUser} before you next type in a session.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (isUsersOwn(e.origin)) {
      const result = await next(e)
      if (result && result.drop === undefined) {
        try {
          await $.store.set(KEY, userTyped(await $.store.get(KEY), await $.session.id(), Date.now()))
          $.ui.status(undefined)
        } catch (err) {
          $.ui.log(`could not note that you typed: ${String(err)}`)
        }
      }
      return result
    }
    const mod = submittingMod(e.origin)
    // A peer session's message or a task notice is not a mod starting a turn: those have their own
    // limits in Claude Code, and this guard leaves them alone.
    if (mod === null) return next(e)
    const { sid, refusal } = await judge($, mod, e.text)
    if (refusal !== undefined) return { drop: refusal }
    try {
      return await next(e)
    } finally {
      await release($, sid)
    }
  }).catch(async ($, e, next) => {
    // Claude Code skips a hook that throws or runs out of time, which would let every mod's prompt
    // through. Fail closed for mods, and never stand between the person and their own prompt.
    if (next.called) return next(e)
    if (isUsersOwn(e.origin) || submittingMod(e.origin) === null) return next(e)
    return { drop: `${submittingMod(e.origin)}: the prompt guard failed, so this prompt was not sent` }
  })
}
