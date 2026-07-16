import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureScrollPosition, restoreScrollPosition } from '../src/scrollPosition.mjs'

test('restores a document scroll offset after the same file is refreshed', () => {
  const positions = new Map()
  captureScrollPosition(positions, { id: '/workspace/report.docx', scroller: { scrollTop: 1470 } })

  const refreshed = { id: '/workspace/report.docx', scroller: { scrollTop: 0 } }
  restoreScrollPosition(positions, refreshed)

  assert.equal(refreshed.scroller.scrollTop, 1470)
})

test('does not leak one document scroll offset into another document', () => {
  const positions = new Map([['/workspace/first.docx', 900]])
  const second = { id: '/workspace/second.docx', scroller: { scrollTop: 200 } }

  restoreScrollPosition(positions, second)

  assert.equal(second.scroller.scrollTop, 0)
})
