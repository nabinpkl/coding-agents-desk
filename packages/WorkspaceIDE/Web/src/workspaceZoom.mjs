const minimumWorkspaceZoom = 0.6
const maximumWorkspaceZoom = 2

export function normalizeWorkspaceZoom(value) {
  const scale = Number.isFinite(value) ? value : 1
  return Math.min(maximumWorkspaceZoom, Math.max(minimumWorkspaceZoom, scale))
}

export function applyWorkspaceZoom(root, value) {
  const scale = normalizeWorkspaceZoom(value)
  const inversePercent = `${100 / scale}%`
  Object.assign(root.style, {
    transform: `scale(${scale})`,
    transformOrigin: 'top left',
    width: inversePercent,
    height: inversePercent,
  })
  return scale
}
