import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DocxViewport } from '../src/docxViewport.ts'

class StubElement {
  constructor({ clientWidth = 0, scrollWidth = 0, scrollHeight = 0 } = {}) {
    this.clientWidth = clientWidth
    this.scrollWidth = scrollWidth
    this.scrollHeight = scrollHeight
    this.scrollLeft = 0
    this.scrollTop = 0
    this.offsetLeft = 0
    this.offsetTop = 0
    this.style = {}
    this.listeners = new Map()
    this.wrapper = null
  }

  addEventListener(type, listener) { this.listeners.set(type, listener) }
  removeEventListener(type) { this.listeners.delete(type) }
  querySelector() { return this.wrapper }
  getBoundingClientRect() { return { left: 0, top: 0 } }
}

const inertResizeObserver = () => ({ observe() {}, disconnect() {} })

test('fits preserved Word page geometry to the viewport before applying user zoom', () => {
  const scroller = new StubElement({ clientWidth: 420 })
  const host = new StubElement()
  const wrapper = new StubElement({ scrollWidth: 840, scrollHeight: 1200 })
  host.wrapper = wrapper

  const viewport = new DocxViewport(scroller, host, {
    createResizeObserver: inertResizeObserver,
  })

  assert.equal(viewport.zoom, 1)
  assert.equal(viewport.fitScale, 0.5)
  assert.equal(viewport.effectiveScale, 0.5)
  assert.equal(host.style.width, '420px')
  assert.equal(host.style.height, '600px')
  assert.equal(wrapper.style.width, 'max-content')
  assert.equal(wrapper.style.transform, 'scale(0.5)')
})

test('buttons and pinch share one bounded document zoom state', () => {
  const scroller = new StubElement({ clientWidth: 420 })
  const host = new StubElement()
  host.wrapper = new StubElement({ scrollWidth: 840, scrollHeight: 1200 })
  const viewport = new DocxViewport(scroller, host, {
    createResizeObserver: inertResizeObserver,
  })

  viewport.zoomOut()
  assert.equal(viewport.zoom, 0.8)
  assert.equal(viewport.effectiveScale, 0.4)

  const touchStart = scroller.listeners.get('touchstart')
  const touchMove = scroller.listeners.get('touchmove')
  touchStart({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }] })
  let prevented = false
  touchMove({
    touches: [{ clientX: 0, clientY: 0 }, { clientX: 200, clientY: 0 }],
    preventDefault() { prevented = true },
  })
  assert.equal(prevented, true)
  assert.equal(viewport.zoom, 1.6)

  viewport.setZoom(99)
  assert.equal(viewport.zoom, 4)
  viewport.setZoom(0.1)
  assert.equal(viewport.zoom, 0.5)
})

test('resize recomputes fit-width without changing the user zoom', () => {
  const scroller = new StubElement({ clientWidth: 420 })
  const host = new StubElement()
  host.wrapper = new StubElement({ scrollWidth: 840, scrollHeight: 1200 })
  const viewport = new DocxViewport(scroller, host, {
    initialZoom: 0.5,
    createResizeObserver: inertResizeObserver,
  })

  scroller.clientWidth = 840
  viewport.layout()

  assert.equal(viewport.zoom, 0.5)
  assert.equal(viewport.fitScale, 1)
  assert.equal(viewport.effectiveScale, 0.5)
  assert.equal(host.style.width, '420px')
})

test('workspace zoom preserves the fit baseline so the outer region controls direction', () => {
  const scroller = new StubElement({ clientWidth: 420 })
  const host = new StubElement()
  host.wrapper = new StubElement({ scrollWidth: 840, scrollHeight: 1200 })
  const viewport = new DocxViewport(scroller, host, {
    createResizeObserver: inertResizeObserver,
  })

  assert.equal(viewport.zoom, 1)
  assert.equal(viewport.effectiveScale, 0.5)
  assert.equal(host.style.width, '420px')

  scroller.clientWidth = 350
  viewport.setWorkspaceScale(1.2)

  assert.equal(viewport.workspaceScale, 1.2)
  assert.equal(viewport.effectiveScale, 0.5)
  assert.equal(host.style.width, '420px')

  scroller.clientWidth = 525
  viewport.setWorkspaceScale(0.8)

  assert.equal(viewport.zoom, 1)
  assert.equal(viewport.workspaceScale, 0.8)
  assert.equal(viewport.effectiveScale, 0.5)
  assert.equal(host.style.width, '420px')
})
