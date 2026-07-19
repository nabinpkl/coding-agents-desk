export function captureDocumentViewport(states, state) {
  if (!state?.scroller) return
  states.set(state.id, {
    scrollLeft: state.scroller.scrollLeft,
    scrollTop: state.scroller.scrollTop,
    zoom: state.viewport?.zoom ?? 1,
  })
}

export function documentZoomFor(states, id) {
  return states.get(id)?.zoom ?? 1
}

export function restoreDocumentViewport(states, state) {
  if (!state?.scroller) return
  const saved = states.get(state.id)
  state.scroller.scrollLeft = saved?.scrollLeft ?? 0
  state.scroller.scrollTop = saved?.scrollTop ?? 0
}
