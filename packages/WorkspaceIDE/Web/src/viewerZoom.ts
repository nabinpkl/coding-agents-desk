export const DEFAULT_TEXT_ZOOM = Object.freeze({
  editorCodePointSize: 12.5,
  markdownPointSize: 14,
})

const MINIMUM_TEXT_ZOOM = Object.freeze({
  editorCodePointSize: 9.5,
  markdownPointSize: 11,
})

const MAXIMUM_TEXT_ZOOM = Object.freeze({
  editorCodePointSize: 20.5,
  markdownPointSize: 22,
})

const TEXT_ZOOM_STEP = 1

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function normalizedPointSize(value, fallback, minimum, maximum) {
  return clamp(Number.isFinite(value) ? value : fallback, minimum, maximum)
}

function normalizedTextZoom(value) {
  return {
    editorCodePointSize: normalizedPointSize(
      value?.editorCodePointSize,
      DEFAULT_TEXT_ZOOM.editorCodePointSize,
      MINIMUM_TEXT_ZOOM.editorCodePointSize,
      MAXIMUM_TEXT_ZOOM.editorCodePointSize,
    ),
    markdownPointSize: normalizedPointSize(
      value?.markdownPointSize,
      DEFAULT_TEXT_ZOOM.markdownPointSize,
      MINIMUM_TEXT_ZOOM.markdownPointSize,
      MAXIMUM_TEXT_ZOOM.markdownPointSize,
    ),
  }
}

export class ViewerZoomController {
  constructor({ applyTextZoom }) {
    this.applyTextZoom = applyTextZoom
    this.textZoom = { ...DEFAULT_TEXT_ZOOM }
  }

  setTextZoom(value) {
    this.textZoom = normalizedTextZoom(value)
    this.applyTextZoom(this.textZoom)
  }

  zoomIn(activeView) {
    this.adjust(activeView, TEXT_ZOOM_STEP)
  }

  zoomOut(activeView) {
    this.adjust(activeView, -TEXT_ZOOM_STEP)
  }

  adjust(activeView, delta) {
    if (!activeView) return
    if (activeView.kind === 'docx') {
      if (delta > 0) activeView.viewport?.zoomIn()
      else activeView.viewport?.zoomOut()
      return
    }
    this.setTextZoom({
      editorCodePointSize: this.textZoom.editorCodePointSize + delta,
      markdownPointSize: this.textZoom.markdownPointSize + delta,
    })
  }
}
