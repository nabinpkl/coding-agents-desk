import { normalizeWorkspaceZoom } from './workspaceZoom.ts'

const minimumZoom = 0.5
const maximumZoom = 4
const zoomStep = 1.25

const clamp = (value, lower, upper) => Math.min(Math.max(value, lower), upper)

const touchDistance = (touches) => Math.hypot(
  touches[1].clientX - touches[0].clientX,
  touches[1].clientY - touches[0].clientY,
)

const touchMidpoint = (touches) => ({
  x: (touches[0].clientX + touches[1].clientX) / 2,
  y: (touches[0].clientY + touches[1].clientY) / 2,
})

export class DocxViewport {
  constructor(scroller, documentHost, {
    initialZoom = 1,
    workspaceScale = 1,
    createResizeObserver = (callback) => new ResizeObserver(callback),
  } = {}) {
    this.scroller = scroller
    this.documentHost = documentHost
    this.wrapper = documentHost.querySelector(':scope > .docx-wrapper')
    if (!this.wrapper) throw new Error('DOCX renderer did not produce a document wrapper')

    this.minimumZoom = minimumZoom
    this.maximumZoom = maximumZoom
    this.zoomStep = zoomStep
    this.zoom = clamp(initialZoom, this.minimumZoom, this.maximumZoom)
    this.workspaceScale = normalizeWorkspaceZoom(workspaceScale)
    this.fitScale = 1
    this.effectiveScale = 1
    this.baseWidth = 0
    this.pinch = null

    Object.assign(this.documentHost.style, {
      position: 'relative',
      marginLeft: 'auto',
      marginRight: 'auto',
    })
    Object.assign(this.wrapper.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: 'max-content',
      maxWidth: 'none',
      transformOrigin: 'top left',
    })

    this.onTouchStart = (event) => this.handleTouchStart(event)
    this.onTouchMove = (event) => this.handleTouchMove(event)
    this.onTouchEnd = () => { this.pinch = null }
    this.onWheel = (event) => this.handleWheel(event)
    scroller.addEventListener('touchstart', this.onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', this.onTouchMove, { passive: false })
    scroller.addEventListener('touchend', this.onTouchEnd, { passive: true })
    scroller.addEventListener('touchcancel', this.onTouchEnd, { passive: true })
    scroller.addEventListener('wheel', this.onWheel, { passive: false })

    this.resizeObserver = createResizeObserver(() => this.layout())
    this.resizeObserver.observe(scroller)
    this.resizeObserver.observe(this.wrapper)
    this.layout()
  }

  layout() {
    this.baseWidth = Math.max(this.baseWidth, this.wrapper.scrollWidth)
    const baseHeight = this.wrapper.scrollHeight
    if (this.baseWidth <= 0 || baseHeight <= 0) return

    const viewportWidth = this.scroller.clientWidth * this.workspaceScale
    this.fitScale = viewportWidth > 0 ? Math.min(1, viewportWidth / this.baseWidth) : 1
    this.applyScale(baseHeight)
  }

  setZoom(requestedZoom, anchor = null) {
    const nextZoom = clamp(requestedZoom, this.minimumZoom, this.maximumZoom)
    if (nextZoom === this.zoom) return
    const baseHeight = this.wrapper.scrollHeight
    const documentAnchor = anchor ? this.documentAnchor(anchor) : null
    this.zoom = nextZoom
    this.applyScale(baseHeight)
    if (documentAnchor) this.restoreAnchor(documentAnchor)
  }

  zoomIn() { this.setZoom(this.zoom * this.zoomStep) }
  zoomOut() { this.setZoom(this.zoom / this.zoomStep) }

  setWorkspaceScale(requestedScale) {
    const nextScale = normalizeWorkspaceZoom(requestedScale)
    if (nextScale === this.workspaceScale) return
    this.workspaceScale = nextScale
    this.layout()
  }

  destroy() {
    this.resizeObserver.disconnect()
    this.scroller.removeEventListener('touchstart', this.onTouchStart)
    this.scroller.removeEventListener('touchmove', this.onTouchMove)
    this.scroller.removeEventListener('touchend', this.onTouchEnd)
    this.scroller.removeEventListener('touchcancel', this.onTouchEnd)
    this.scroller.removeEventListener('wheel', this.onWheel)
  }

  applyScale(baseHeight) {
    this.effectiveScale = this.fitScale * this.zoom
    this.wrapper.style.transform = `scale(${this.effectiveScale})`
    this.documentHost.style.width = `${this.baseWidth * this.effectiveScale}px`
    this.documentHost.style.height = `${baseHeight * this.effectiveScale}px`
  }

  handleTouchStart(event) {
    if (event.touches.length !== 2) return
    this.pinch = {
      distance: touchDistance(event.touches),
      zoom: this.zoom,
    }
  }

  handleTouchMove(event) {
    if (!this.pinch || event.touches.length !== 2) return
    event.preventDefault()
    const distance = touchDistance(event.touches)
    if (this.pinch.distance <= 0) return
    this.setZoom(this.pinch.zoom * distance / this.pinch.distance, touchMidpoint(event.touches))
  }

  handleWheel(event) {
    if (!event.ctrlKey) return
    event.preventDefault()
    this.setZoom(this.zoom * Math.exp(-event.deltaY * 0.01), { x: event.clientX, y: event.clientY })
  }

  documentAnchor(anchor) {
    const scrollerRect = this.scroller.getBoundingClientRect()
    const viewportX = anchor.x - scrollerRect.left
    const viewportY = anchor.y - scrollerRect.top
    return {
      x: (this.scroller.scrollLeft + viewportX - this.documentHost.offsetLeft) / this.effectiveScale,
      y: (this.scroller.scrollTop + viewportY - this.documentHost.offsetTop) / this.effectiveScale,
      viewportX,
      viewportY,
    }
  }

  restoreAnchor(documentAnchor) {
    this.scroller.scrollLeft = Math.max(
      0,
      this.documentHost.offsetLeft + documentAnchor.x * this.effectiveScale - documentAnchor.viewportX,
    )
    this.scroller.scrollTop = Math.max(
      0,
      this.documentHost.offsetTop + documentAnchor.y * this.effectiveScale - documentAnchor.viewportY,
    )
  }
}
