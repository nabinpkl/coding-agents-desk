import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderDocx, responsiveDocxOptions } from '../src/renderDocx.ts'

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
  const expectedViewport = { zoom: 0.8 }
  let invocation
  let viewportArguments

  const viewport = await renderDocx(container, 'app://app/document/current', {
    fetchResource: async () => ({
      ok: true,
      arrayBuffer: async () => expectedBytes,
    }),
    renderDocument: async (...args) => { invocation = args },
    initialZoom: 0.8,
    workspaceScale: 1.1,
    createViewport: (...args) => {
      viewportArguments = args
      return expectedViewport
    },
  })

  const scroller = container.children[0]
  assert.equal(viewport, expectedViewport)
  assert.equal(scroller.className, 'docx-scroll')
  assert.equal(scroller.children[0].className, 'docx-document')
  assert.equal(viewportArguments[0], scroller)
  assert.equal(viewportArguments[1], scroller.children[0])
  assert.deepEqual(viewportArguments[2], { initialZoom: 0.8, workspaceScale: 1.1 })
  assert.equal(invocation[0], expectedBytes)
  assert.equal(invocation[1], scroller.children[0])
  assert.equal(invocation[2], undefined)
  assert.equal(invocation[3], responsiveDocxOptions)
  assert.equal(responsiveDocxOptions.ignoreWidth, false)
  assert.equal(responsiveDocxOptions.ignoreHeight, false)
  assert.equal(responsiveDocxOptions.renderAltChunks, false)
})

test('keeps browser page zoom fixed because DOCX owns its viewport scale', () => {
  assert.match(
    viewerHTML,
    /name="viewport"[\s\S]*minimum-scale=1, maximum-scale=1, user-scalable=no/,
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
