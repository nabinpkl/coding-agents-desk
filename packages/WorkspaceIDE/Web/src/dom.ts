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
/// generated icon set. Returns the svg itself, not a wrapper, so sizing and stroke utilities land
/// on the element they actually govern.
export function glyph(className: string, path: string, viewBox = '0 0 16 16'): SVGSVGElement {
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('aria-hidden', 'true')
  const shape = document.createElementNS(svgNS, 'path')
  shape.setAttribute('d', path)
  svg.append(shape)
  return svg
}

/// A directory's chevron is its only mark: it takes the icon column so filenames stay aligned in
/// one column whether the row is a file or a folder, and rotates in place when expanded.
export function chevron(isExpanded: boolean): SVGSVGElement {
  const svg = glyph(
    'shrink-0 size-4 block fill-none stroke-current stroke-[1.7] [stroke-linecap:round]'
    + ' [stroke-linejoin:round] data-[expanded=true]:rotate-90',
    'M6 3.5 10.5 8 6 12.5',
  )
  svg.dataset.expanded = String(isExpanded)
  return svg
}

/// The generic outline drawn for a file whose type we carry no icon for. Deliberately uncoloured:
/// a grey page reads as "just a file", where a borrowed logo would assert a language it isn't.
const unknownFileShape = Object.freeze({
  viewBox: '0 0 16 16',
  body: '<path d="M3 1.5h6.2l3.8 3.8v9.2H3v-13Zm6 1.4v2.6h2.6L9 2.9Z"/>',
})

export function fileIcon(name: string): SVGSVGElement {
  const { icon } = fileIconSpec(name)
  const shape = fileIconShape(icon) ?? unknownFileShape
  const svg = document.createElementNS(svgNS, 'svg')
  // The generated icons carry their own `fill` per path, so `currentColor` only ever reaches the
  // fallback glyph — which is exactly the one that should take the row's muted colour.
  svg.setAttribute('class', 'shrink-0 size-4 block fill-current text-ide-muted')
  svg.setAttribute('viewBox', shape.viewBox)
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('aria-hidden', 'true')
  // Build-time constant from src/generated/fileIcons.ts, never a filename or any other runtime
  // value, so this carries no injection surface.
  svg.innerHTML = shape.body
  return svg
}
