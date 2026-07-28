import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  captureDocumentViewport,
  documentZoomFor,
  restoreDocumentViewport,
} from '../src/documentViewportState.ts'

test('restores document zoom and both scroll axes after the same file is refreshed', () => {
  const states = new Map()
  captureDocumentViewport(states, {
    id: '/workspace/report.docx',
    scroller: { scrollLeft: 220, scrollTop: 1470 },
    viewport: { zoom: 0.8 },
  })

  const refreshed = { id: '/workspace/report.docx', scroller: { scrollLeft: 0, scrollTop: 0 } }
  restoreDocumentViewport(states, refreshed)

  assert.equal(documentZoomFor(states, refreshed.id), 0.8)
  assert.equal(refreshed.scroller.scrollLeft, 220)
  assert.equal(refreshed.scroller.scrollTop, 1470)
})

test('does not leak one document viewport into another document', () => {
  const states = new Map([[
    '/workspace/first.docx',
    { scrollLeft: 100, scrollTop: 900, zoom: 2 },
  ]])
  const second = { id: '/workspace/second.docx', scroller: { scrollLeft: 200, scrollTop: 200 } }

  restoreDocumentViewport(states, second)

  assert.equal(documentZoomFor(states, second.id), 1)
  assert.equal(second.scroller.scrollLeft, 0)
  assert.equal(second.scroller.scrollTop, 0)
})
