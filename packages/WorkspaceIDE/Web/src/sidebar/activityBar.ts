import { button, element, glyph } from '../dom.ts'
import type { Send, SidebarSection } from '../projection.ts'

/// Stroked outlines, not the filled brand marks the file rows use: these are chrome, so they read
/// as controls that take the row's colour rather than as another piece of content.
const sectionShapes: Record<SidebarSection, string> = {
  explorer:
    'M2.4 4.4c0-.7.6-1.3 1.3-1.3h2.6l1.5 1.6h4.5c.7 0 1.3.6 1.3 1.3v5.9c0 .7-.6 1.3-1.3 1.3H3.7c-.7 0-1.3-.6-1.3-1.3V4.4Z',
  sourceControl:
    'M4.6 5.6v5M4.6 12.7a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8ZM4.6 5.4a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8ZM11.6 5.4a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8ZM11.6 5.6v1.1a2.6 2.6 0 0 1-2.6 2.6H6.5',
}

const sections: Array<{ id: SidebarSection; label: string }> = [
  { id: 'explorer', label: 'Explorer' },
  { id: 'sourceControl', label: 'Source Control' },
]

export interface ActivityBar {
  readonly root: HTMLElement
  select(section: SidebarSection): void
}

/// Stroked and unfilled, sized so the two glyphs share an optical weight with the row chevrons
/// beneath them rather than competing with the file icons.
const glyphChrome = 'size-[17px] block fill-none stroke-current stroke-[1.3] [stroke-linecap:round] [stroke-linejoin:round]'
const buttonChrome = 'grid place-items-center w-[30px] h-[27px] rounded-md hover:bg-ide-hover'

export function activityBar(send: Send): ActivityBar {
  const root = element('nav', 'flex gap-1 px-[7px] py-[5px] border-b border-ide-border')
  root.setAttribute('aria-label', 'Workspace sidebar sections')
  const buttons = new Map<SidebarSection, HTMLButtonElement>()
  for (const { id, label } of sections) {
    const control = button('', `Show ${label}`, () =>
      send({ type: 'selectSidebarSection', section: id }))
    control.className = buttonChrome
    // The name is gone from the pixels but not from the surface: `aria-label` carries it to
    // VoiceOver and `title` brings it back on hover for anyone still learning the two glyphs.
    control.title = label
    control.append(glyph(glyphChrome, sectionShapes[id]))
    buttons.set(id, control)
    root.append(control)
  }
  return {
    root,
    select(section) {
      for (const [id, control] of buttons) {
        const selected = id === section
        control.className = selected
          ? `${buttonChrome} text-ide-fg bg-ide-selected`
          : `${buttonChrome} text-ide-muted`
        control.setAttribute('aria-pressed', String(selected))
      }
    },
  }
}
