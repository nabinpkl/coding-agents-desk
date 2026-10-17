// What agentdesk-hub does with the hub reader's output, without the mods API, so it can be tested
// on its own: lines from pieces, the prompt each message becomes, and the queue that holds a
// message until its prompt has entered the session.
import { agentKindLine, agentPreamble, ownerKindLine } from './hubKindWording.ts'

/** Joins the pieces a spawned child's output arrives in ("text as it came, not lines") into lines. */
export class LineBuffer {
  constructor() {
    this.rest = ''
  }

  /** The complete lines this piece finishes; a partial last line waits for the next piece. */
  push(text) {
    const parts = (this.rest + text).split('\n')
    this.rest = parts.pop() ?? ''
    return parts.filter((line) => line.trim() !== '')
  }
}

/** One reader line (`src/messaging/hubReader.ts`), or null when it is not one. */
export function parseReaderLine(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  if (value.type === 'beat') return { type: 'beat' }
  const m = value.message
  if (value.type !== 'message' || typeof value.streamId !== 'string' || !m || typeof m.id !== 'string' || typeof m.body !== 'string') return null
  return { type: 'message', streamId: value.streamId, fromName: typeof value.fromName === 'string' ? value.fromName : String(m.from), message: m }
}

function describeRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return ''
  return '\n\nRefs:\n' + refs.map((r) => `- ${r.app} ${r.kind} ${r.id}${r.url ? ` (${r.url})` : ''}`).join('\n')
}

/** The tag that marks where the message itself starts and ends, apart from what this mod says about it. */
export const MESSAGE_TAG = 'hub-message'

function attribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The message's own text, unable to open or close the tag it sits in: a body that wrote
 * `</hub-message>` would otherwise end the message early and have what follows read as this mod's
 * own words.
 */
function messageText(text) {
  // Every "<" and its fullwidth and small lookalikes, not the spellings of one tag: a pattern for
  // the tag let "< /hub-message>" through (2026-10-17); with no bracket left, no spelling slips.
  return String(text).replace(/[<\uFF1C\uFE64]/g, '&lt;')
}

/** The message, inside its tag, with what the hub knows about it as the tag's attributes. */
function taggedMessage(message, fromName) {
  const attrs = [
    ['from', message.fromKind === 'human' ? 'you' : fromName],
    ['sender', message.from],
    ['from_kind', message.fromKind],
    ['kind', message.kind],
    ['hops', message.hops],
    ['thread_id', message.threadId],
    ['message_id', message.id],
    ...(message.inReplyTo ? [['in_reply_to', message.inReplyTo]] : []),
  ]
  const open = `<${MESSAGE_TAG} ${attrs.map(([k, v]) => `${k}="${attribute(v)}"`).join(' ')}>`
  return `${open}\n${messageText(message.body)}${messageText(describeRefs(message.refs))}\n</${MESSAGE_TAG}>`
}

/**
 * The prompt a message becomes: the message inside a `<hub-message>` tag, and what this mod says
 * about it outside the tag, so the two cannot be mistaken for each other. The person's own words go
 * in as theirs. Another agent's say plainly what they are, because Claude Code frames a mod's
 * prompt as "The agentdesk-hub plugin sent a message", and a bare instruction under that frame was
 * read as a prompt injection and declined (measured on Haiku, 2026-10-16). What the agent's message
 * asks for comes from the kind its sender chose, not from its text, in the wording opencode sessions
 * are given too (`hubKindWording.ts`).
 */
export function framePrompt({ message, fromName }) {
  if (message.fromKind === 'human') {
    return {
      asUser: true,
      text: [`From you, via the agent hub:`, '', taggedMessage(message, fromName), '', ownerKindLine(message)].join('\n'),
    }
  }
  return {
    asUser: false,
    text: [
      agentPreamble(MESSAGE_TAG),
      agentKindLine(message),
      '',
      taggedMessage(message, fromName),
    ].join('\n'),
  }
}

/**
 * Whether a prompt carrying this message already went into the session, read from the session's own
 * messages. The mod can be reloaded (an edit, which lands as the running turn ends) at the moment a
 * prompt it submitted goes in: the old copy never confirms it, the hub pushes it again, and only the
 * transcript can say it already arrived.
 *
 * Only the opening <hub-message> tag counts, matched as a whole line. A body cannot write one (the
 * tag is escaped inside it, `messageText`), so another message cannot claim this one arrived and
 * have it confirmed without ever being delivered. Prompts in the format before the tag are not
 * recognised: their header line could be written by a body.
 */
export function promptCarriesMessage(messages, messageId) {
  const escaped = attribute(messageId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const opening = new RegExp(`^<${MESSAGE_TAG} [^>\\n]* message_id="${escaped}"[^>\\n]*>$`, 'm')
  return Array.isArray(messages) && messages.some((m) => m && m.role === 'user' && typeof m.text === 'string' && opening.test(m.text))
}

/**
 * Messages the reader handed over, in the order they came, each with the newest stream it came on:
 * the hub refuses a confirmation that names a stream the message is no longer waiting on.
 * `entered` names the messages whose prompt already went in; one of those arriving again (its
 * confirmation was lost, so the hub pushed it once more) is only confirmed, never submitted twice.
 */
export class DeliveryQueue {
  constructor(entered = new Set()) {
    this.entered = entered
    this.waiting = []
  }

  /** `confirm`: it already went in, confirm it on this stream. `queued` or `updated`: it waits. */
  arrive(delivery) {
    if (this.entered.has(delivery.message.id)) return 'confirm'
    const held = this.waiting.find((d) => d.message.id === delivery.message.id)
    if (held) {
      held.streamId = delivery.streamId
      return 'updated'
    }
    this.waiting.push({ ...delivery })
    return 'queued'
  }

  head() {
    return this.waiting[0]
  }

  /** Whether this message is still waiting here, including the one whose prompt is on its way in. */
  holds(messageId) {
    return this.waiting.some((d) => d.message.id === messageId)
  }

  /** The head cannot go in: it leaves the queue unconfirmed, and arrives again if the hub pushes it again. */
  setAsideHead() {
    this.waiting.shift()
  }

  /** The head's prompt went in: it leaves the queue, and the stream to confirm it on is returned. */
  enteredHead() {
    const head = this.waiting.shift()
    if (!head) return undefined
    this.entered.add(head.message.id)
    return head.streamId
  }
}
