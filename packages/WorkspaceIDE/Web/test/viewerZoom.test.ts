import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TEXT_ZOOM,
  ViewerZoomController,
} from '../src/viewerZoom.ts'

test('non-document zoom updates bounded editor and preview text sizes', () => {
  const applied = []
  const zoom = new ViewerZoomController({ applyTextZoom: (value) => applied.push(value) })
  const text = { kind: 'markdown' }

  zoom.zoomIn(text)
  assert.deepEqual(applied.at(-1), { editorCodePointSize: 13.5, markdownPointSize: 14 })

  for (let index = 0; index < 20; index += 1) zoom.zoomOut(text)
  assert.deepEqual(applied.at(-1), { editorCodePointSize: 9.5, markdownPointSize: 10 })
})

test('document zoom delegates to the responsive viewport without changing text zoom', () => {
  const applied = []
  const calls = []
  const zoom = new ViewerZoomController({ applyTextZoom: (value) => applied.push(value) })
  const document = {
    kind: 'docx',
    viewport: {
      zoomIn: () => calls.push('in'),
      zoomOut: () => calls.push('out'),
    },
  }

  zoom.zoomIn(document)
  zoom.zoomOut(document)

  assert.deepEqual(calls, ['in', 'out'])
  assert.deepEqual(applied, [])
  assert.deepEqual(zoom.textZoom, DEFAULT_TEXT_ZOOM)
})

test('host-provided text zoom becomes the baseline for later controls', () => {
  const applied = []
  const zoom = new ViewerZoomController({ applyTextZoom: (value) => applied.push(value) })

  zoom.setTextZoom({ editorCodePointSize: 16.5, markdownPointSize: 17 })
  zoom.zoomOut({ kind: 'text' })

  assert.deepEqual(applied, [
    { editorCodePointSize: 16.5, markdownPointSize: 17 },
    { editorCodePointSize: 15.5, markdownPointSize: 16 },
  ])
})
