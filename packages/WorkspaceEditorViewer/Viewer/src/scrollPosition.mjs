export function captureScrollPosition(positions, state) {
  if (state?.scroller) positions.set(state.id, state.scroller.scrollTop)
}

export function restoreScrollPosition(positions, state) {
  if (!state?.scroller) return
  state.scroller.scrollTop = positions.get(state.id) ?? 0
}
