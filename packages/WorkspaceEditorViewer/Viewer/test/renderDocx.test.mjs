import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderDocx, responsiveDocxOptions } from '../src/renderDocx.mjs'

const viewerHTML = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')

class StubElement {
  constructor(tagName) {
    this.tagName = tagName
    this.className = ''
    this.children = []
  }

  appendChild(child) {
    this.children.push(child)
    return child
  }

  replaceChildren(...children) {
    this.children = children
  }
}

globalThis.document = {
  createElement: (tagName) => new StubElement(tagName),
}

test('renders DOCX bytes into one responsive scrolling surface', async () => {
  const container = new StubElement('main')
  const expectedBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer
  let invocation

  const scroller = await renderDocx(container, 'app://app/document/current', {
    fetchResource: async () => ({
      ok: true,
      arrayBuffer: async () => expectedBytes,
    }),
    renderDocument: async (...args) => { invocation = args },
  })

  assert.equal(container.children[0], scroller)
  assert.equal(scroller.className, 'docx-scroll')
  assert.equal(scroller.children[0].className, 'docx-document')
  assert.equal(invocation[0], expectedBytes)
  assert.equal(invocation[1], scroller.children[0])
  assert.equal(invocation[2], undefined)
  assert.equal(invocation[3], responsiveDocxOptions)
  assert.equal(responsiveDocxOptions.ignoreWidth, true)
  assert.equal(responsiveDocxOptions.ignoreHeight, true)
  assert.equal(responsiveDocxOptions.renderAltChunks, false)
})

test('admits the native iOS document zoom range in the viewport contract', () => {
  assert.match(
    viewerHTML,
    /name="viewport"[\s\S]*minimum-scale=1, maximum-scale=4, user-scalable=yes/,
  )
})

test('fails loudly when the native document resource cannot be read', async () => {
  const container = new StubElement('main')
  await assert.rejects(
    renderDocx(container, 'app://app/document/missing', {
      fetchResource: async () => ({ ok: false, status: 404 }),
    }),
    /DOCX content request failed \(404\)/,
  )
})
