// The DOM vocabulary every region builds from. Each renderer below takes data plus a `send` and
// returns an element — props in, element out — so a component is a module, not a framework object.

import { fileIconShape, fileIconSpec } from './ideModel.ts'

const svgNS = 'http://www.w3.org/2000/svg'

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag)
  if (className) value.className = className
  return value
}

export function button(title: string, label: string, action: () => void): HTMLButtonElement {
  const value = element('button')
  value.type = 'button'
  value.textContent = title
  value.setAttribute('aria-label', label)
  value.addEventListener('click', action)
  return value
}

/// An `<svg>` with a single path, for the glyphs we draw ourselves rather than take from the
/// generated icon set. Stroke-vs-fill is a styling decision, so it stays in CSS.
export function glyph(className: string, path: string, viewBox = '0 0 16 16'): HTMLSpanElement {
  const container = element('span', className)
  container.setAttribute('aria-hidden', 'true')
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('focusable', 'false')
  const shape = document.createElementNS(svgNS, 'path')
  shape.setAttribute('d', path)
  svg.append(shape)
  container.append(svg)
  return container
}

/// A directory's chevron is its only mark: it takes the icon column so filenames stay aligned in
/// one column whether the row is a file or a folder. CSS rotates it when expanded.
export function chevron(isExpanded: boolean): HTMLSpanElement {
  const container = glyph('ide-tree-chevron', 'M6 3.5 10.5 8 6 12.5')
  container.dataset.expanded = String(isExpanded)
  return container
}

/// The generic outline drawn for a file whose type we carry no icon for. Deliberately uncoloured:
/// a grey page reads as "just a file", where a borrowed logo would assert a language it isn't.
const unknownFileShape = Object.freeze({
  viewBox: '0 0 16 16',
  body: '<path d="M3 1.5h6.2l3.8 3.8v9.2H3v-13Zm6 1.4v2.6h2.6L9 2.9Z"/>',
})

export function fileIcon(name: string): HTMLSpanElement {
  const { icon } = fileIconSpec(name)
  const shape = fileIconShape(icon) ?? unknownFileShape
  const container = element('span', 'ide-file-icon')
  container.setAttribute('aria-hidden', 'true')
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('viewBox', shape.viewBox)
  svg.setAttribute('focusable', 'false')
  // Build-time constant from src/generated/fileIcons.ts, never a filename or any other runtime
  // value, so this carries no injection surface.
  svg.innerHTML = shape.body
  container.append(svg)
  return container
}
